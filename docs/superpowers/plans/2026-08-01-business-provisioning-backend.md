# Business Account Provisioning — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `medialane-backend` a data model and API surface for business-account
bulk wallet provisioning — a business registers wallets it has already deployed
on-chain (owned by a business-derived interim key), recipients claim them by email,
and the backend verifies the on-chain owner handoff before marking a row claimed.

**Architecture:** Two new Prisma models (`BusinessProvisioning`,
`ProvisioningClaimToken`) plus one new route file with five endpoints (register, list,
public claim-info, public claim-submit, complete). All Starknet transaction *signing*
and *submission* happens outside this backend (the business's own tooling, per the
design spec) — this backend only **verifies on-chain state** via a new `chainRead`
function, exactly like the existing `CollectionClaim` and x402 settlement paths already
do. No new transaction-relay surface is introduced.

**Tech Stack:** Hono, Prisma v5 + PostgreSQL, Bun test runner, `starknet` (RPC reads
only), nodemailer (existing `utils/mailer.ts`).

## Global Constraints

- Runtime is Bun only — `bun`, never `node`/`npm`/`npx`.
- Always `normalizeAddress("STARKNET", address)` before any DB write or query
  involving an address — never `.toLowerCase()` alone.
- Chain reads throw on RPC failure; callers surface an error, never fall back to the DB
  for an authorization decision (07-identity §V).
- Every new field on `schema.prisma` needs a real migration file
  (`bun run db:migrate`) — editing the schema alone does not update prod.
- `{ error: string }` for failures; `{ data: T }` for single items, `{ data: T[] }` for
  lists — the existing response-shape convention.
- **No client-specific naming or internal rationale anywhere in this repo** (spec §8.1)
  — model names, route paths, comments, email copy, and test fixtures must stay fully
  generic ("business", "recipient", "asset"). This repo is open source.
- Public (no API key) routes must be added to `PUBLIC_V1_PATHS` in
  `src/api/middleware/apiKeyGate.ts` — that file is the single place this decision is
  made, not mount order in `server.ts`.

---

## File Structure

- `prisma/schema.prisma` — add `ProvisioningStatus` enum, `BusinessProvisioning` +
  `ProvisioningClaimToken` models, back-relation on `Account`.
- `src/chainRead/index.ts` — add `isAccountOwner(chain, accountAddress, ownerPubkey)`.
- `src/utils/mailer.ts` — add `sendProvisioningClaimEmail(to, claimUrl)`.
- `src/api/routes/business-provisioning.ts` — new route file, DI-shaped (mirrors
  `src/api/middleware/adminSignatureAuth.ts`'s `Deps` pattern) so route logic is
  testable without a live DB or RPC.
- `src/api/routes/business-provisioning.test.ts` — route-level tests via
  `app.request()` with injected fake deps.
- `src/api/server.ts` — mount the new router.
- `src/api/middleware/apiKeyGate.ts` — add the two public claim-token paths.

---

### Task 1: Prisma schema — provisioning models

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a migration under `prisma/migrations/` (via `db:migrate`)

**Interfaces:**
- Produces: `ProvisioningStatus` enum (`DEPLOYED | HANDOFF | TRANSFERRED`),
  `BusinessProvisioning` model, `ProvisioningClaimToken` model — consumed by every
  later task.

- [ ] **Step 1: Add the enum + models to `schema.prisma`**

Add near the existing `CollectionClaim`/`ClaimChallenge` models (around line 370):

```prisma
enum ProvisioningStatus {
  DEPLOYED
  HANDOFF
  TRANSFERRED
}

model BusinessProvisioning {
  id                 String             @id @default(cuid())
  accountId          String
  chain              Chain              @default(STARKNET)
  walletAddress      String
  recipientEmail     String
  interimOwnerPubkey String
  newOwnerPubkey     String?
  status             ProvisioningStatus @default(DEPLOYED)
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt

  account     Account                  @relation(fields: [accountId], references: [id])
  claimTokens ProvisioningClaimToken[]

  @@unique([chain, walletAddress])
  @@index([accountId, status])
}

model ProvisioningClaimToken {
  id             String    @id @default(cuid())
  provisioningId String
  token          String    @unique
  expiresAt      DateTime
  consumedAt     DateTime?
  createdAt      DateTime  @default(now())

  provisioning BusinessProvisioning @relation(fields: [provisioningId], references: [id])

  @@index([provisioningId])
}
```

Add the back-relation to the existing `Account` model (find `payments Payment[]` around
line 769 and add a line under it):

```prisma
  businessProvisioning BusinessProvisioning[]
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:migrate`
When prompted for a migration name, use: `add_business_provisioning`
Expected: a new directory under `prisma/migrations/` containing the generated SQL, and
`prisma/schema.prisma` unchanged beyond what you just wrote (the command only adds the
migration file + regenerates the client — verify with `git status` that no unrelated
schema drift got captured).

- [ ] **Step 3: Regenerate the Prisma client and typecheck**

Run: `bun run db:generate && bun run typecheck`
Expected: no errors. (`typecheck` will fail here if any later task's code isn't written
yet — at this point in the plan there is no consuming code, so it should pass clean.)

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add BusinessProvisioning + ProvisioningClaimToken models"
```

---

### Task 2: `chainRead.isAccountOwner`

**Files:**
- Modify: `src/chainRead/index.ts`
- Test: `src/chainRead/isAccountOwner.test.ts`

**Interfaces:**
- Consumes: `callRpc` from `../utils/starknet.js` (existing).
- Produces: `isAccountOwner(chain: Chain, accountAddress: string, ownerPubkey: string): Promise<boolean>` — consumed by Task 4's register/complete handlers.

This calls the MediaWallet account contract's `is_owner(owner: Signer) -> bool`. A
`Signer::Starknet(StarknetSigner { pubkey })` Cairo enum serializes over Serde as
`[0, pubkey]` — enum variant tag `0` (Starknet is the first variant), followed by the
one felt (`NonZero<felt252>` serializes as the felt itself). Verified against
`medialane-contracts/contracts/MediaWallet/src/signer/signer_signature.cairo`.

- [ ] **Step 1: Write the failing test**

Since `callRpc` talks to a real RPC provider, test the Starknet implementation function
directly by injecting a fake provider through a small seam. Add this test file:

```ts
// src/chainRead/isAccountOwner.test.ts
import { describe, expect, test, mock } from "bun:test";

describe("starknet is_owner calldata", () => {
  test("encodes Signer::Starknet(pubkey) as [tag=0, pubkey] and parses a truthy result", async () => {
    let capturedCall: { contractAddress: string; entrypoint: string; calldata: string[] } | undefined;
    const fakeProvider = {
      callContract: mock(async (call: any) => {
        capturedCall = call;
        return ["0x1"];
      }),
    };
    // Inject the fake provider by monkey-patching callRpc's module-level accessor
    // is out of scope here — Task 2 Step 3 restructures isAccountOwner to accept
    // an optional provider-fetcher for exactly this reason. Re-import after that
    // restructure makes this call directly testable:
    const { __unstable_starknetIsAccountOwnerWithProvider } = await import("./index.js");
    const result = await __unstable_starknetIsAccountOwnerWithProvider(
      fakeProvider as any,
      "0xaccount",
      "0xpubkey",
    );
    expect(capturedCall).toEqual({
      contractAddress: "0xaccount",
      entrypoint: "is_owner",
      calldata: ["0x0", "0xpubkey"],
    });
    expect(result).toBe(true);
  });

  test("parses a falsy on-chain result as false", async () => {
    const fakeProvider = { callContract: mock(async () => ["0x0"]) };
    const { __unstable_starknetIsAccountOwnerWithProvider } = await import("./index.js");
    const result = await __unstable_starknetIsAccountOwnerWithProvider(fakeProvider as any, "0xaccount", "0xpubkey");
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/chainRead/isAccountOwner.test.ts`
Expected: FAIL — `__unstable_starknetIsAccountOwnerWithProvider` is not exported yet.

- [ ] **Step 3: Implement in `src/chainRead/index.ts`**

Add near `getCollectionOwner` (public dispatch section):

```ts
/**
 * Is `ownerPubkey` currently a registered owner of the MediaWallet account at
 * `accountAddress`? Used to verify business-provisioning handoffs on-chain
 * before trusting a claim as complete — never trust the DB alone for this.
 */
export async function isAccountOwner(chain: Chain, accountAddress: string, ownerPubkey: string): Promise<boolean> {
  switch (chain) {
    case "STARKNET":
      return starknetIsAccountOwner(accountAddress, ownerPubkey);
    default:
      throw new Error(`Owner-membership reads not implemented for chain "${chain}"`);
  }
}
```

Add near the other `starknet*` implementations:

```ts
async function starknetIsAccountOwner(accountAddress: string, ownerPubkey: string): Promise<boolean> {
  return callRpc((provider) => __unstable_starknetIsAccountOwnerWithProvider(provider, accountAddress, ownerPubkey));
}

// Exported under an intentionally unstable name — exists only so tests can inject a
// fake provider without a live RPC. Not part of the module's public surface.
export async function __unstable_starknetIsAccountOwnerWithProvider(
  provider: { callContract: (call: { contractAddress: string; entrypoint: string; calldata: string[] }) => Promise<string[]> },
  accountAddress: string,
  ownerPubkey: string,
): Promise<boolean> {
  // Signer::Starknet(StarknetSigner{ pubkey }) → Serde [tag=0, pubkey].
  const res = await provider.callContract({
    contractAddress: accountAddress,
    entrypoint: "is_owner",
    calldata: ["0x0", ownerPubkey],
  });
  return BigInt(res[0]) === 1n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/chainRead/isAccountOwner.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/chainRead/index.ts src/chainRead/isAccountOwner.test.ts
git commit -m "feat: add chainRead.isAccountOwner for MediaWallet owner-membership checks"
```

---

### Task 3: Claim email

**Files:**
- Modify: `src/utils/mailer.ts`
- Test: `src/utils/mailer.provisioning.test.ts`

**Interfaces:**
- Produces: `sendProvisioningClaimEmail(to: string, claimUrl: string): Promise<void>` —
  consumed by Task 4.

**Corrected during execution (2026-08-01):** the original version of this task mocked
`nodemailer` via `mock.module`. This repo's `CLAUDE.md` explicitly rules that out — "not
`mock.module` — it leaks process-globally" — and it did: the test passed in isolation but
broke the full suite when run alongside other files. Fixed by splitting the email into a
pure content-builder (unit-testable, no mocking) and leaving the transport-sending half
untested, matching every other function in this file (`sendUsernameClaimApproved`/
`Rejected` have no tests either — the established convention here is DI or pure
functions only, not "mock the SDK").

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/mailer.provisioning.test.ts
import { describe, expect, test } from "bun:test";
import { buildProvisioningClaimEmailHtml } from "./mailer.js";

describe("buildProvisioningClaimEmailHtml", () => {
  test("includes the claim URL and stays generic — no client-specific wording", () => {
    const html = buildProvisioningClaimEmailHtml("https://medialane.io/claim/abc123");
    expect(html).toContain("https://medialane.io/claim/abc123");
    expect(html.toLowerCase()).not.toContain("magazine");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/mailer.provisioning.test.ts`
Expected: FAIL — `buildProvisioningClaimEmailHtml` is not exported.

- [ ] **Step 3: Implement in `src/utils/mailer.ts`**

Add after `sendUsernameClaimRejected`:

```ts
/**
 * Pure HTML builder, split out from sendProvisioningClaimEmail so its content can be
 * unit-tested without mocking the mail transport (mock.module leaks process-globally
 * in this repo's bun test runs — DI or pure functions only).
 */
export function buildProvisioningClaimEmailHtml(claimUrl: string): string {
  return `
    <p>Hi there,</p>
    <p>An account has been set up for you, with your assets already in it.</p>
    <p>Claim it as your own — this takes a minute and confirms it belongs to you:<br>
    <a href="${claimUrl}">${claimUrl}</a></p>
    <p>— The Medialane Team</p>
  `;
}

export async function sendProvisioningClaimEmail(to: string, claimUrl: string): Promise<void> {
  const transporter = createTransporter();
  if (!transporter) { log.warn("SMTP not configured — skipping provisioning claim email"); return; }
  try {
    await transporter.sendMail({
      from: from(),
      to,
      subject: "An account is ready for you on Medialane",
      html: buildProvisioningClaimEmailHtml(claimUrl),
    });
  } catch (err) {
    log.error({ err }, "Failed to send provisioning claim email");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/mailer.provisioning.test.ts`
Expected: PASS. Then run `bun test src` (the whole suite) to confirm nothing else broke —
this is the step that would have caught the original `mock.module` regression.

- [ ] **Step 5: Commit**

```bash
git add src/utils/mailer.ts src/utils/mailer.provisioning.test.ts
git commit -m "feat: add sendProvisioningClaimEmail"
```

---

### Task 4: Register + list routes (business-authed)

**Files:**
- Create: `src/api/routes/business-provisioning.ts`
- Test: `src/api/routes/business-provisioning.test.ts`

**Interfaces:**
- Consumes: `isAccountOwner` (Task 2), `sendProvisioningClaimEmail` (Task 3).
- Produces: `BusinessProvisioningDeps` interface, `createBusinessProvisioningRoutes(deps)` factory, `businessProvisioningRoutes` production singleton — the router mounted in Task 6. Also produces the `ProvisioningRecord` type Task 5 extends.

- [ ] **Step 1: Write the failing tests**

```ts
// src/api/routes/business-provisioning.test.ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createBusinessProvisioningRoutes, type BusinessProvisioningDeps, type ProvisioningRecord } from "./business-provisioning.js";

function makeApp(deps: BusinessProvisioningDeps, accountId = "biz-1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: accountId, plan: "FREE", status: "ACTIVE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/business/provisioning", createBusinessProvisioningRoutes(deps));
  return app;
}

function fakeDeps(overrides: Partial<BusinessProvisioningDeps> = {}): BusinessProvisioningDeps {
  const store = new Map<string, ProvisioningRecord>();
  return {
    isAccountOwner: async () => true,
    createProvisioning: async (input) => {
      const record: ProvisioningRecord = { id: "prov-1", status: "DEPLOYED", newOwnerPubkey: null, ...input };
      store.set(record.id, record);
      return record;
    },
    listProvisioning: async (accountId) => [...store.values()].filter((r) => r.accountId === accountId),
    getProvisioningById: async (id, accountId) => {
      const r = store.get(id);
      return r && r.accountId === accountId ? r : null;
    },
    markClaimed: async (id) => {
      const r = store.get(id)!;
      const updated = { ...r, status: "TRANSFERRED" as const };
      store.set(id, updated);
      return updated;
    },
    recordNewOwnerPubkey: async (id, pubkey) => {
      const r = store.get(id)!;
      const updated = { ...r, newOwnerPubkey: pubkey, status: "HANDOFF" as const };
      store.set(id, updated);
      return updated;
    },
    createClaimToken: async () => ({ token: "tok_1", expiresAt: new Date(Date.now() + 86_400_000) }),
    findClaimToken: async () => null,
    consumeClaimToken: async () => {},
    sendClaimEmail: async () => {},
    ...overrides,
  };
}

describe("POST /v1/business/provisioning", () => {
  test("registers a provisioned wallet after verifying the interim owner on-chain", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        walletAddress: "0xWallet",
        recipientEmail: "worker@example.com",
        interimOwnerPubkey: "0xInterim",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: ProvisioningRecord };
    expect(body.data.status).toBe("DEPLOYED");
    expect(body.data.accountId).toBe("biz-1");
  });

  test("rejects when the interim key is not actually the on-chain owner", async () => {
    const deps = fakeDeps({ isAccountOwner: async () => false });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        walletAddress: "0xWallet",
        recipientEmail: "worker@example.com",
        interimOwnerPubkey: "0xInterim",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("interim_owner_mismatch");
  });
});

describe("GET /v1/business/provisioning", () => {
  test("lists only the caller's own rows", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    await deps.createProvisioning({ accountId: "biz-1", chain: "STARKNET", walletAddress: "0xA", recipientEmail: "a@example.com", interimOwnerPubkey: "0x1" });
    await deps.createProvisioning({ accountId: "biz-2", chain: "STARKNET", walletAddress: "0xB", recipientEmail: "b@example.com", interimOwnerPubkey: "0x2" });
    const res = await app.request("/v1/business/provisioning");
    const body = (await res.json()) as { data: ProvisioningRecord[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].walletAddress).toBe("0xA");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/routes/business-provisioning.test.ts`
Expected: FAIL — `./business-provisioning.js` does not exist.

- [ ] **Step 3: Implement `src/api/routes/business-provisioning.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { isAccountOwner as realIsAccountOwner } from "../../chainRead/index.js";
import { sendProvisioningClaimEmail as realSendClaimEmail } from "../../utils/mailer.js";
import crypto from "crypto";
import type { Chain, ProvisioningStatus } from "@prisma/client";

export interface ProvisioningRecord {
  id: string;
  accountId: string;
  chain: Chain;
  walletAddress: string;
  recipientEmail: string;
  interimOwnerPubkey: string;
  newOwnerPubkey: string | null;
  status: ProvisioningStatus;
}

export interface BusinessProvisioningDeps {
  isAccountOwner: (chain: Chain, walletAddress: string, ownerPubkey: string) => Promise<boolean>;
  createProvisioning: (input: {
    accountId: string; chain: Chain; walletAddress: string; recipientEmail: string; interimOwnerPubkey: string;
  }) => Promise<ProvisioningRecord>;
  listProvisioning: (accountId: string, status?: ProvisioningStatus) => Promise<ProvisioningRecord[]>;
  getProvisioningById: (id: string, accountId: string) => Promise<ProvisioningRecord | null>;
  markClaimed: (id: string) => Promise<ProvisioningRecord>;
  recordNewOwnerPubkey: (id: string, newOwnerPubkey: string) => Promise<ProvisioningRecord>;
  createClaimToken: (input: { provisioningId: string }) => Promise<{ token: string; expiresAt: Date }>;
  findClaimToken: (token: string) => Promise<{ provisioningId: string; expiresAt: Date; consumedAt: Date | null } | null>;
  consumeClaimToken: (token: string) => Promise<void>;
  sendClaimEmail: (to: string, claimUrl: string) => Promise<void>;
}

const registerSchema = z.object({
  chain: z.enum(["STARKNET"]).default("STARKNET"),
  walletAddress: z.string(),
  recipientEmail: z.string().email(),
  interimOwnerPubkey: z.string(),
});

export function createBusinessProvisioningRoutes(deps: BusinessProvisioningDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", zValidator("json", registerSchema), async (c) => {
    const { chain, walletAddress, recipientEmail, interimOwnerPubkey } = c.req.valid("json");
    const accountId = c.get("account").id;
    const normWallet = normalizeAddress(chain, walletAddress);
    const normPubkey = normalizeAddress(chain, interimOwnerPubkey);

    const ok = await deps.isAccountOwner(chain, normWallet, normPubkey);
    if (!ok) return c.json({ error: "interim_owner_mismatch" }, 400);

    const record = await deps.createProvisioning({
      accountId, chain, walletAddress: normWallet, recipientEmail, interimOwnerPubkey: normPubkey,
    });

    const { token, expiresAt } = await deps.createClaimToken({ provisioningId: record.id });
    void expiresAt; // recorded by createClaimToken; not needed in the response
    const claimUrl = `https://medialane.io/claim/${token}`;
    await deps.sendClaimEmail(recipientEmail, claimUrl);

    return c.json({ data: record }, 201);
  });

  app.get("/", async (c) => {
    const accountId = c.get("account").id;
    const status = c.req.query("status") as ProvisioningStatus | undefined;
    const rows = await deps.listProvisioning(accountId, status);
    return c.json({ data: rows });
  });

  return app;
}

const productionDeps: BusinessProvisioningDeps = {
  isAccountOwner: realIsAccountOwner,
  createProvisioning: (input) => prisma.businessProvisioning.create({ data: input }),
  listProvisioning: (accountId, status) =>
    prisma.businessProvisioning.findMany({ where: { accountId, ...(status ? { status } : {}) } }),
  getProvisioningById: async (id, accountId) => {
    const row = await prisma.businessProvisioning.findUnique({ where: { id } });
    return row && row.accountId === accountId ? row : null;
  },
  markClaimed: (id) => prisma.businessProvisioning.update({ where: { id }, data: { status: "TRANSFERRED" } }),
  recordNewOwnerPubkey: (id, newOwnerPubkey) =>
    prisma.businessProvisioning.update({ where: { id }, data: { newOwnerPubkey, status: "HANDOFF" } }),
  createClaimToken: async ({ provisioningId }) => {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.provisioningClaimToken.create({ data: { provisioningId, token, expiresAt } });
    return { token, expiresAt };
  },
  findClaimToken: (token) => prisma.provisioningClaimToken.findUnique({ where: { token } }),
  consumeClaimToken: async (token) => {
    await prisma.provisioningClaimToken.update({ where: { token }, data: { consumedAt: new Date() } });
  },
  sendClaimEmail: realSendClaimEmail,
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionDeps);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/routes/business-provisioning.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (`ProvisioningStatus`/`Chain` come from `@prisma/client`, generated
in Task 1 — if this fails with a missing export, re-run `bun run db:generate`.)

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/business-provisioning.ts src/api/routes/business-provisioning.test.ts
git commit -m "feat: add business provisioning register/list routes"
```

---

### Task 5: Public claim routes

**Files:**
- Modify: `src/api/routes/business-provisioning.ts`
- Modify: `src/api/routes/business-provisioning.test.ts`

**Interfaces:**
- Consumes: `BusinessProvisioningDeps` (Task 4).
- Produces: `GET /claim/:token` and `POST /claim/:token` on the same router — consumed
  by Task 7 (public-path registration) and, in a later plan, media-wallet's claim
  landing page.

- [ ] **Step 1: Write the failing tests**

Append to `business-provisioning.test.ts`:

```ts
describe("GET /v1/business/provisioning/claim/:token", () => {
  test("returns the wallet summary for a valid, unexpired token", async () => {
    const deps = fakeDeps({
      findClaimToken: async (token) =>
        token === "tok_1" ? { provisioningId: "prov-1", expiresAt: new Date(Date.now() + 1000), consumedAt: null } : null,
      getProvisioningById: async (id) =>
        id === "prov-1"
          ? { id: "prov-1", accountId: "biz-1", chain: "STARKNET", walletAddress: "0xA", recipientEmail: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: null, status: "DEPLOYED" }
          : null,
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { walletAddress: string } };
    expect(body.data.walletAddress).toBe("0xA");
  });

  test("404s for an unknown token", async () => {
    const app = makeApp(fakeDeps({ findClaimToken: async () => null }));
    const res = await app.request("/v1/business/provisioning/claim/nope");
    expect(res.status).toBe(404);
  });

  test("410s for an expired token", async () => {
    const deps = fakeDeps({
      findClaimToken: async () => ({ provisioningId: "prov-1", expiresAt: new Date(Date.now() - 1000), consumedAt: null }),
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1");
    expect(res.status).toBe(410);
  });
});

describe("POST /v1/business/provisioning/claim/:token", () => {
  test("records the recipient's new owner key and consumes the token", async () => {
    let consumed = "";
    let recorded: { id: string; pubkey: string } | undefined;
    const deps = fakeDeps({
      findClaimToken: async () => ({ provisioningId: "prov-1", expiresAt: new Date(Date.now() + 1000), consumedAt: null }),
      recordNewOwnerPubkey: async (id, pubkey) => {
        recorded = { id, pubkey };
        return { id, accountId: "biz-1", chain: "STARKNET", walletAddress: "0xA", recipientEmail: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: pubkey, status: "HANDOFF" };
      },
      consumeClaimToken: async (token) => { consumed = token; },
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerPubkey: "0xNew" }),
    });
    expect(res.status).toBe(200);
    expect(recorded).toEqual({ id: "prov-1", pubkey: "0xNew" });
    expect(consumed).toBe("tok_1");
  });

  test("rejects an already-consumed token", async () => {
    const deps = fakeDeps({
      findClaimToken: async () => ({ provisioningId: "prov-1", expiresAt: new Date(Date.now() + 1000), consumedAt: new Date() }),
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerPubkey: "0xNew" }),
    });
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/routes/business-provisioning.test.ts`
Expected: FAIL — the new routes (`/claim/:token`) don't exist yet (404 on all of them).

- [ ] **Step 3: Implement the routes**

Add to `createBusinessProvisioningRoutes` in `business-provisioning.ts`, before the
`return app;` line:

```ts
  app.get("/claim/:token", async (c) => {
    const token = c.req.param("token");
    const claim = await deps.findClaimToken(token);
    if (!claim) return c.json({ error: "not_found" }, 404);
    if (claim.consumedAt || claim.expiresAt < new Date()) return c.json({ error: "expired" }, 410);
    // getProvisioningById is account-scoped by design (Task 4); the public claim
    // surface looks the row up directly since the caller only has the token, never
    // an authenticated business account — accountId is irrelevant to this read.
    const record = await deps.getProvisioningById(claim.provisioningId, "");
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json({ data: { chain: record.chain, walletAddress: record.walletAddress, recipientEmail: record.recipientEmail } });
  });

  app.post("/claim/:token", zValidator("json", z.object({ newOwnerPubkey: z.string() })), async (c) => {
    const token = c.req.param("token");
    const { newOwnerPubkey } = c.req.valid("json");
    const claim = await deps.findClaimToken(token);
    if (!claim) return c.json({ error: "not_found" }, 404);
    if (claim.consumedAt || claim.expiresAt < new Date()) return c.json({ error: "expired" }, 410);

    const record = await deps.recordNewOwnerPubkey(claim.provisioningId, normalizeAddress("STARKNET", newOwnerPubkey));
    await deps.consumeClaimToken(token);
    return c.json({ data: record });
  });
```

`getProvisioningById` as defined in Task 4's production wiring ignores the account-scope
check when called with `""` only in the sense that no real account will ever have
`accountId === ""` — this keeps the function's signature single-purpose (always scoped)
while the public route still gets a real record back, since Prisma's lookup is by `id`
first and the equality check is what would reject a mismatch, not what's needed here.
**Fix this in Step 3a below** — it's cleaner to give the public path its own unscoped
read rather than abuse the scoped one with a sentinel.

- [ ] **Step 3a: Replace the sentinel with a dedicated unscoped read**

Add to `BusinessProvisioningDeps`:

```ts
  getProvisioningByIdUnscoped: (id: string) => Promise<ProvisioningRecord | null>;
```

Add to `productionDeps`:

```ts
  getProvisioningByIdUnscoped: (id) => prisma.businessProvisioning.findUnique({ where: { id } }),
```

Update the `GET /claim/:token` handler to call `deps.getProvisioningByIdUnscoped(claim.provisioningId)` instead of `deps.getProvisioningById(claim.provisioningId, "")`.

Update `fakeDeps` in the test file: rename the `getProvisioningById` overrides used in
the two `GET /claim/:token` tests to `getProvisioningByIdUnscoped` (both the default in
`fakeDeps` — add `getProvisioningByIdUnscoped: async () => null,` to its base object —
and the per-test override in the "returns the wallet summary" test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/routes/business-provisioning.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/business-provisioning.ts src/api/routes/business-provisioning.test.ts
git commit -m "feat: add public claim-info and claim-submit routes"
```

---

### Task 6: Complete route (on-chain verified handoff)

**Files:**
- Modify: `src/api/routes/business-provisioning.ts`
- Modify: `src/api/routes/business-provisioning.test.ts`

**Interfaces:**
- Consumes: `deps.isAccountOwner`, `deps.markClaimed`, `deps.getProvisioningById`.
- Produces: `POST /:id/complete` — the last route this plan adds.

- [ ] **Step 1: Write the failing tests**

Append to `business-provisioning.test.ts`:

```ts
describe("POST /v1/business/provisioning/:id/complete", () => {
  const claimPendingRecord: ProvisioningRecord = {
    id: "prov-1", accountId: "biz-1", chain: "STARKNET", walletAddress: "0xA",
    recipientEmail: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: "0xNew", status: "HANDOFF",
  };

  test("marks TRANSFERRED once the new owner is confirmed on-chain and the interim owner is gone", async () => {
    const deps = fakeDeps({
      getProvisioningById: async (id, accountId) => (id === "prov-1" && accountId === "biz-1" ? claimPendingRecord : null),
      isAccountOwner: async (_chain, _wallet, pubkey) => pubkey === "0xNew",
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/prov-1/complete", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ProvisioningRecord };
    expect(body.data.status).toBe("TRANSFERRED");
  });

  test("409s when the on-chain handoff isn't confirmed yet", async () => {
    const deps = fakeDeps({
      getProvisioningById: async () => claimPendingRecord,
      isAccountOwner: async () => false,
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/prov-1/complete", { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("404s for a row that belongs to a different business account", async () => {
    const deps = fakeDeps({ getProvisioningById: async () => null });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/prov-1/complete", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/routes/business-provisioning.test.ts`
Expected: FAIL — `/:id/complete` doesn't exist (404 where 200/409 expected).

- [ ] **Step 3: Implement the route**

Add to `createBusinessProvisioningRoutes`, before `return app;`:

```ts
  app.post("/:id/complete", async (c) => {
    const id = c.req.param("id");
    const accountId = c.get("account").id;
    const record = await deps.getProvisioningById(id, accountId);
    if (!record) return c.json({ error: "not_found" }, 404);
    if (!record.newOwnerPubkey) return c.json({ error: "not_claimed_yet" }, 409);

    const [newOwnerConfirmed, interimStillOwner] = await Promise.all([
      deps.isAccountOwner(record.chain, record.walletAddress, record.newOwnerPubkey),
      deps.isAccountOwner(record.chain, record.walletAddress, record.interimOwnerPubkey),
    ]);
    if (!newOwnerConfirmed || interimStillOwner) return c.json({ error: "handoff_not_confirmed_onchain" }, 409);

    const updated = await deps.markClaimed(id);
    return c.json({ data: updated });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/routes/business-provisioning.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Full test suite + typecheck**

Run: `bun test src && bun run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/business-provisioning.ts src/api/routes/business-provisioning.test.ts
git commit -m "feat: add on-chain-verified provisioning completion route"
```

---

### Task 7: Mount + public-path registration

**Files:**
- Modify: `src/api/server.ts`
- Modify: `src/api/middleware/apiKeyGate.ts`
- Test: `src/api/middleware/apiKeyGate.test.ts` (extend if it exists; create if not)

**Interfaces:**
- Consumes: `businessProvisioningRoutes` (Task 4).
- Produces: the router live at `/v1/business/provisioning`, with the two `/claim/:token`
  paths reachable without an API key.

- [ ] **Step 1: Check for an existing `apiKeyGate` test file**

Run: `ls src/api/middleware/apiKeyGate.test.ts 2>/dev/null || echo "none"`

If it exists, read it first and add the new cases in its existing style. If it doesn't,
create it fresh with just the two cases below (Step 2).

- [ ] **Step 2: Write the failing test**

```ts
// src/api/middleware/apiKeyGate.test.ts (create if it doesn't already exist)
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyGate } from "./apiKeyGate.js";

describe("apiKeyGate — business provisioning claim paths", () => {
  test("GET /v1/business/provisioning/claim/:token bypasses the API key requirement", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.get("/v1/business/provisioning/claim/:token", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/business/provisioning/claim/tok_1");
    expect(res.status).toBe(200);
  });

  test("POST /v1/business/provisioning/claim/:token bypasses the API key requirement", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.post("/v1/business/provisioning/claim/:token", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/business/provisioning/claim/tok_1", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("GET /v1/business/provisioning (list) is NOT public — still requires a key", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.get("/v1/business/provisioning", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/business/provisioning");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/api/middleware/apiKeyGate.test.ts`
Expected: FAIL on the first two cases (currently gated, so 401 instead of 200).

- [ ] **Step 4: Add the public paths**

In `src/api/middleware/apiKeyGate.ts`, add to `PUBLIC_V1_PATHS`:

```ts
  { method: "GET", pattern: /^\/v1\/business\/provisioning\/claim\/[^/]+$/ },
  { method: "POST", pattern: /^\/v1\/business\/provisioning\/claim\/[^/]+$/ },
```

- [ ] **Step 5: Mount the router in `src/api/server.ts`**

Add the import near the other claim-router imports:

```ts
import { businessProvisioningRoutes } from "./routes/business-provisioning.js";
```

Add the mount near `app.route("/v1/collections/claim", claims);`:

```ts
  app.route("/v1/business/provisioning", businessProvisioningRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/api/middleware/apiKeyGate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Full suite + typecheck + build**

Run: `bun test src && bun run typecheck && bun run build 2>/dev/null || true`

(This repo has no dedicated build-check command beyond `typecheck` per its own
`CLAUDE.md` — `bun run typecheck` is the authoritative gate. Read the full output, not a
filtered subset.)

Expected: all tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/api/server.ts src/api/middleware/apiKeyGate.ts src/api/middleware/apiKeyGate.test.ts
git commit -m "feat: mount business provisioning routes, exempt claim paths from API key gate"
```

---

## Self-Review Notes

- **Spec coverage:** design spec §4 steps 3–6 (record provisioning, email, recipient
  claims, on-chain-verified completion) are covered by Tasks 1–7. Steps 1–2 (business's
  own key derivation and on-chain deploy/mint) are explicitly out of this backend's
  scope per the design — that's the SDK provisioning utility, a separate plan. §5
  (unclaimed reissue) is achievable today by the business calling `change_owners` again
  directly on-chain and re-registering via `POST /v1/business/provisioning` with a new
  interim key — no dedicated reissue endpoint was added since nothing in the spec
  requires one yet (YAGNI); flag this as a candidate follow-up if the portal console
  plan finds it's needed.
- **§8.1 naming discipline:** verified no client/deal-specific wording anywhere —
  model names, route paths, and email copy all stay generic.
- **Left open for the SDK/portal/media-wallet plans:** the claim URL is hardcoded to
  `https://medialane.io/claim/...` in Task 4 — the portal-console plan should confirm
  this is the right host once that surface exists (media-wallet's claim landing may live
  at a different path).
