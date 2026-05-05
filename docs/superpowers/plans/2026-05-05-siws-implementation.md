# SIWS (Sign-In With Starknet) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unverified `x-wallet-address` header with a cryptographically verified SIWS flow — wallet users sign a SNIP-12 message once, receive a `siws_` prefixed token, and use it as `Authorization: Bearer siws_<token>` on all subsequent requests.

**Architecture:** Two new public endpoints (`POST /v1/auth/siws/nonce` and `POST /v1/auth/siws/verify`) handle the handshake. Tokens are HMAC-SHA256 signed server-side with no external library. `identityAuth` gains a `siws_` prefix branch that verifies the token locally in ~0.1ms. Clerk path is untouched.

**Tech Stack:** Bun, Hono, Prisma, starknet.js v6 (`account.verifyMessage` — already used in `claims.ts`), Node.js built-in `crypto`. No new dependencies.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | Add `SIWS_SECRET` required env var |
| `prisma/schema.prisma` | Modify | Add `SiwsNonce` model |
| `src/utils/siwsToken.ts` | Create | `issueToken(wallet)` + `verifyToken(raw)` — pure, no side effects |
| `src/api/routes/siws.ts` | Create | `POST /nonce` + `POST /verify` endpoints |
| `src/api/server.ts` | Modify | Mount siws router at `/v1/auth/siws` BEFORE global apiKeyAuth |
| `src/api/middleware/identityAuth.ts` | Modify | Add `siws_` branch; remove `x-wallet-address` branch |
| `src/api/middleware/cors.ts` | Modify | Remove `x-wallet-address` from `allowHeaders` |

---

## Task 1: Add `SIWS_SECRET` to env config

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Add the env var to the Zod schema**

  In `src/config/env.ts`, add after the `HMAC_KEY` line (line 36):

  ```typescript
  SIWS_SECRET: z.string().min(32),
  ```

  The full relevant section becomes:
  ```typescript
  HMAC_KEY: z.string().default(""),
  SIWS_SECRET: z.string().min(32),
  CORS_ORIGINS: z
  ```

- [ ] **Step 2: Add `SIWS_SECRET` to your local `.env.local`**

  Generate a secret and add it:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

  Add the output to `.env.local`:
  ```
  SIWS_SECRET=<generated_value>
  ```

- [ ] **Step 3: Verify the server still starts**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run --smol src/index.ts
  ```

  Expected: only missing env var errors for `DATABASE_URL` etc., NOT for `SIWS_SECRET` (since it's now in `.env.local`). If you see `SIWS_SECRET: Required`, check that `.env.local` is being loaded.

- [ ] **Step 4: Commit**

  ```bash
  git add src/config/env.ts
  git commit -m "feat(siws): add SIWS_SECRET env var"
  ```

---

## Task 2: Add `SiwsNonce` Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the model to schema.prisma**

  Open `prisma/schema.prisma`. Add after the `ClaimChallenge` model (after line ~306):

  ```prisma
  model SiwsNonce {
    id            String   @id @default(cuid())
    walletAddress String
    nonce         String   @unique
    expiresAt     DateTime
    createdAt     DateTime @default(now())

    @@index([walletAddress])
  }
  ```

- [ ] **Step 2: Run the migration**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run db:migrate
  ```

  When prompted for a migration name, enter: `add_siws_nonce`

  Expected output includes:
  ```
  ✔ Generated Prisma Client
  The following migration(s) have been created and applied from new schema changes:
  migrations/20260505_add_siws_nonce/migration.sql
  ```

- [ ] **Step 3: Verify the Prisma client was regenerated**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run --smol src/index.ts
  ```

  Expected: clean startup (env var errors only, no Prisma errors).

- [ ] **Step 4: Commit**

  ```bash
  git add prisma/schema.prisma prisma/migrations/
  git commit -m "feat(siws): add SiwsNonce model and migration"
  ```

---

## Task 3: Create `siwsToken.ts` — token issue + verify

**Files:**
- Create: `src/utils/siwsToken.ts`

This file has two pure functions. No Prisma, no RPC, no side effects.

- [ ] **Step 1: Create the file**

  Create `src/utils/siwsToken.ts`:

  ```typescript
  import { createHmac, timingSafeEqual } from "crypto";
  import { env } from "../config/env.js";

  const TTL_SECONDS = 86_400; // 24 hours

  interface TokenPayload {
    sub: string; // normalized wallet address
    iat: number; // issued-at unix seconds
    exp: number; // expiry unix seconds
  }

  /**
   * Issue a SIWS bearer token for a verified wallet address.
   * Format: siws_<base64url(payload)>.<hex(hmac-sha256)>
   */
  export function issueToken(wallet: string): string {
    const iat = Math.floor(Date.now() / 1000);
    const payload = b64u(JSON.stringify({ sub: wallet, iat, exp: iat + TTL_SECONDS }));
    const sig = hmac(payload);
    return `siws_${payload}.${sig}`;
  }

  /**
   * Verify a raw bearer token string.
   * Returns the wallet address on success, null on any failure (expired, tampered, wrong format).
   */
  export function verifyToken(raw: string): string | null {
    if (!raw.startsWith("siws_")) return null;
    const inner = raw.slice(5);
    const dot = inner.lastIndexOf(".");
    if (dot === -1) return null;

    const payload = inner.slice(0, dot);
    const provided = inner.slice(dot + 1);
    const expected = hmac(payload);

    // Constant-time comparison — both are 64-char hex strings from HMAC-SHA256
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))) return null;

    let data: TokenPayload;
    try {
      data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }

    if (!data.sub || !data.exp) return null;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;

    return data.sub;
  }

  function b64u(s: string): string {
    return Buffer.from(s).toString("base64url");
  }

  function hmac(payload: string): string {
    return createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");
  }
  ```

- [ ] **Step 2: Smoke test with a scratch script**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun -e "
  import { issueToken, verifyToken } from './src/utils/siwsToken.js';
  const wallet = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
  const token = issueToken(wallet);
  console.log('token starts with siws_:', token.startsWith('siws_'));
  console.log('verify returns wallet:', verifyToken(token) === wallet);
  console.log('tampered token returns null:', verifyToken(token + 'x') === null);
  console.log('wrong prefix returns null:', verifyToken('clerk_' + token.slice(6)) === null);
  "
  ```

  Expected:
  ```
  token starts with siws_: true
  verify returns wallet: true
  tampered token returns null: true
  wrong prefix returns null: true
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/utils/siwsToken.ts
  git commit -m "feat(siws): add siwsToken issue/verify utilities"
  ```

---

## Task 4: Create `siws.ts` route — nonce + verify endpoints

**Files:**
- Create: `src/api/routes/siws.ts`

This route is mounted BEFORE the global `apiKeyAuth` middleware (see Task 5), so it receives no tenant context. Both endpoints are fully public.

The SNIP-12 typed data structure must exactly match what the client wallet will sign. The `nonce` field uses `shortstring` type (≤ 31 ASCII bytes). We generate 15 random bytes → 30-char hex string, which fits.

Signature verification uses `account.verifyMessage` from starknet.js via `callRpc` — the exact same pattern already used in `src/api/routes/claims.ts:203`.

- [ ] **Step 1: Create the file**

  Create `src/api/routes/siws.ts`:

  ```typescript
  import { Hono } from "hono";
  import { zValidator } from "@hono/zod-validator";
  import { z } from "zod";
  import { randomBytes } from "crypto";
  import { Account } from "starknet";
  import prisma from "../../db/client.js";
  import { normalizeAddress, callRpc } from "../../utils/starknet.js";
  import { issueToken } from "../../utils/siwsToken.js";
  import type { AppEnv } from "../../types/hono.js";

  const siws = new Hono<AppEnv>();

  const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** SNIP-12 typed data for a SIWS login message. */
  function buildTypedData(wallet: string, nonce: string) {
    return {
      domain: { name: "Medialane", version: "1", chainId: "SN_MAIN", revision: "1" },
      primaryType: "SiwsMessage",
      types: {
        StarknetDomain: [
          { name: "name",     type: "shortstring" },
          { name: "version",  type: "shortstring" },
          { name: "chainId",  type: "shortstring" },
          { name: "revision", type: "shortstring" },
        ],
        SiwsMessage: [
          { name: "wallet", type: "ContractAddress" },
          { name: "nonce",  type: "shortstring" },
          { name: "app",    type: "shortstring" },
        ],
      },
      message: {
        wallet,
        nonce,
        app: "medialane.io",
      },
    };
  }

  // POST /v1/auth/siws/nonce
  siws.post(
    "/nonce",
    zValidator("json", z.object({ walletAddress: z.string().min(1) })),
    async (c) => {
      const { walletAddress } = c.req.valid("json");
      const wallet = normalizeAddress(walletAddress);
      const nonce = randomBytes(15).toString("hex"); // 30 chars — fits in shortstring
      const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

      await prisma.siwsNonce.create({ data: { walletAddress: wallet, nonce, expiresAt } });

      return c.json({ nonce, typedData: buildTypedData(wallet, nonce) });
    }
  );

  // POST /v1/auth/siws/verify
  siws.post(
    "/verify",
    zValidator("json", z.object({
      walletAddress: z.string().min(1),
      nonce:         z.string().min(1),
      signature:     z.tuple([z.string(), z.string()]),
    })),
    async (c) => {
      const { walletAddress, nonce, signature } = c.req.valid("json");
      const wallet = normalizeAddress(walletAddress);

      const record = await prisma.siwsNonce.findUnique({ where: { nonce } });
      if (!record || record.expiresAt < new Date()) {
        if (record) await prisma.siwsNonce.delete({ where: { nonce } });
        return c.json({ error: "nonce_expired" }, 400);
      }
      if (record.walletAddress !== wallet) {
        return c.json({ error: "wallet_mismatch" }, 400);
      }

      const typedData = buildTypedData(wallet, nonce);
      try {
        const isValid = await callRpc((provider) => {
          const account = new Account(provider, wallet, "0x1");
          return account.verifyMessage(typedData, [
            BigInt(signature[0]).toString(),
            BigInt(signature[1]).toString(),
          ]);
        });
        if (!isValid) return c.json({ error: "invalid_signature" }, 401);
      } catch {
        return c.json({ error: "invalid_signature" }, 401);
      }

      // Single-use: delete nonce after successful verification
      await prisma.siwsNonce.delete({ where: { nonce } });

      return c.json({ token: issueToken(wallet) });
    }
  );

  export default siws;
  ```

- [ ] **Step 2: Verify it compiles**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run --smol src/index.ts
  ```

  Expected: env/DB errors only, no TypeScript errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/api/routes/siws.ts
  git commit -m "feat(siws): add nonce + verify endpoints"
  ```

---

## Task 5: Mount siws router in `server.ts`

**Files:**
- Modify: `src/api/server.ts`

The siws router must be mounted BEFORE `app.use("/v1/*", apiKeyAuth)` so the public auth endpoints don't require a tenant API key.

- [ ] **Step 1: Add the import**

  In `src/api/server.ts`, add after the existing imports (after the `drop` import on line 30):

  ```typescript
  import siws from "./routes/siws.js";
  ```

- [ ] **Step 2: Mount the router**

  In `src/api/server.ts`, add after the `remix-offers` mount (line 51) and BEFORE the `app.use("/v1/*", apiKeyAuth)` line:

  ```typescript
  // SIWS auth — public, no API key required (authentication precedes key issuance)
  app.route("/v1/auth/siws", siws);
  ```

  The block should look like:
  ```typescript
  app.route("/v1/remix-offers", remixOffers);

  // SIWS auth — public, no API key required (authentication precedes key issuance)
  app.route("/v1/auth/siws", siws);

  // All /v1/* routes require a tenant API key
  app.use("/v1/*", apiKeyAuth);
  ```

- [ ] **Step 3: Start the server and verify the endpoints exist**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run dev &
  sleep 3
  curl -s -X POST http://localhost:3000/v1/auth/siws/nonce \
    -H "Content-Type: application/json" \
    -d '{"walletAddress":"0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"}' | jq .
  ```

  Expected (with DB running): a JSON object with `nonce` (30-char hex) and `typedData` fields.

  Expected (without DB): `{"error":"Internal server error"}` — that's fine, it means the route was reached and the DB call failed, not a routing issue.

- [ ] **Step 4: Commit**

  ```bash
  git add src/api/server.ts
  git commit -m "feat(siws): mount siws router before apiKeyAuth"
  ```

---

## Task 6: Update `identityAuth` — add SIWS path, remove x-wallet-address

**Files:**
- Modify: `src/api/middleware/identityAuth.ts`

The `siws_` prefix check runs AFTER the Clerk JWT check. Clerk tokens always start with `eyJ` (base64-encoded `{`), so they never match `siws_`. No ambiguity, no fallback logic.

- [ ] **Step 1: Replace the full file content**

  Write `src/api/middleware/identityAuth.ts`:

  ```typescript
  import { createClerkClient, verifyToken as clerkVerifyToken } from "@clerk/backend";
  import type { Context, Next } from "hono";
  import { normalizeAddress } from "../../utils/starknet.js";
  import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";

  const clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY!,
  });

  /**
   * Resolves caller identity to a walletAddress from two auth paths:
   *
   * Path 1 — Clerk JWT  (Authorization: Bearer eyJ...)
   *   Used by medialane-io / ChipiPay. Validates JWT via Clerk SDK.
   *   Sets walletAddress + clerkUserId.
   *
   * Path 2 — SIWS token  (Authorization: Bearer siws_...)
   *   Used by medialane-dapp, medialane-portal, AI agents.
   *   Verified locally via HMAC — no DB, no RPC call.
   *   Sets walletAddress only.
   *
   * Path 3 (future) — additional verified paths as needed.
   */
  export async function identityAuth(c: Context, next: Next) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const token = authHeader.slice(7);

    // ── Path 2: SIWS token ─────────────────────────────────────────────────────
    if (token.startsWith("siws_")) {
      const wallet = verifySiwsToken(token);
      if (!wallet) return c.json({ error: "Invalid or expired SIWS token" }, 401);
      c.set("walletAddress", wallet);
      return next();
    }

    // ── Path 1: Clerk JWT ──────────────────────────────────────────────────────
    try {
      const payload = await clerkVerifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY!,
      });
      const user = await clerk.users.getUser(payload.sub);
      const rawWallet = (user.publicMetadata?.publicKey ?? user.publicMetadata?.walletAddress) as string | undefined;
      if (!rawWallet) {
        return c.json({ error: "No wallet associated with this account" }, 403);
      }
      c.set("walletAddress", normalizeAddress(rawWallet));
      c.set("clerkUserId", payload.sub);
    } catch {
      return c.json({ error: "Invalid or expired session token" }, 401);
    }

    return next();
  }

  /**
   * Strict variant: only accepts a Clerk JWT.
   * Use on endpoints that must not accept SIWS tokens (e.g. gated content, remix confirm).
   */
  export async function requireClerkJwt(c: Context, next: Next) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7).startsWith("siws_")) {
      return c.json({ error: "Clerk session token required" }, 401);
    }
    return identityAuth(c, next);
  }
  ```

- [ ] **Step 2: Verify it compiles**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run --smol src/index.ts
  ```

  Expected: env/DB errors only.

- [ ] **Step 3: Test Path 2 with a valid SIWS token**

  Issue a token directly and test the middleware by hitting a protected endpoint:

  ```bash
  TOKEN=$(~/.nvm/versions/node/v24.15.0/bin/bun -e "
  import { issueToken } from './src/utils/siwsToken.js';
  console.log(issueToken('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'));
  ")

  curl -s -X POST http://localhost:3000/v1/users/me \
    -H "x-api-key: <any valid tenant key>" \
    -H "Authorization: Bearer $TOKEN" | jq .
  ```

  Expected: `{"walletAddress":"0x049d..."}` or a 404 (user not in DB) — NOT a 401.

- [ ] **Step 4: Test that a bare `x-wallet-address` header no longer works**

  ```bash
  curl -s -X POST http://localhost:3000/v1/users/me \
    -H "x-api-key: <any valid tenant key>" \
    -H "x-wallet-address: 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" | jq .
  ```

  Expected: `{"error":"Authentication required"}` with HTTP 401.

- [ ] **Step 5: Test that Clerk path is untouched (no Clerk JWT = 401, not SIWS error)**

  ```bash
  curl -s -X POST http://localhost:3000/v1/users/me \
    -H "x-api-key: <any valid tenant key>" \
    -H "Authorization: Bearer eyJfake" | jq .
  ```

  Expected: `{"error":"Invalid or expired session token"}` — Clerk error, not SIWS error.

- [ ] **Step 6: Commit**

  ```bash
  git add src/api/middleware/identityAuth.ts
  git commit -m "feat(siws): wire SIWS token path into identityAuth, remove x-wallet-address"
  ```

---

## Task 7: Remove `x-wallet-address` from CORS headers

**Files:**
- Modify: `src/api/middleware/cors.ts`

- [ ] **Step 1: Remove the header**

  In `src/api/middleware/cors.ts`, change line 17:

  ```typescript
  // Before:
  allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-wallet-address"],

  // After:
  allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
  ```

- [ ] **Step 2: Verify it compiles**

  ```bash
  ~/.nvm/versions/node/v24.15.0/bin/bun run --smol src/index.ts
  ```

  Expected: env/DB errors only.

- [ ] **Step 3: Commit**

  ```bash
  git add src/api/middleware/cors.ts
  git commit -m "feat(siws): remove x-wallet-address from CORS allowHeaders"
  ```

---

## Task 8: Add `SIWS_SECRET` to Railway

- [ ] **Step 1: Generate and add the secret to Railway**

  Generate a production secret:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

  In Railway dashboard → your service → Variables → add:
  ```
  SIWS_SECRET=<generated_value>
  ```

- [ ] **Step 2: Push to production**

  ```bash
  git push origin main
  ```

  Expected: Railway picks up the new migration (`add_siws_nonce`) and applies it on startup. Health check passes.

---

## Final Verification Checklist

- [ ] `POST /v1/auth/siws/nonce` returns `{ nonce, typedData }` (no API key needed)
- [ ] `POST /v1/auth/siws/verify` returns `{ token: "siws_..." }` after valid signature
- [ ] `Authorization: Bearer siws_<token>` authenticates on any `identityAuth` route
- [ ] `Authorization: Bearer eyJ<clerkToken>` still works on medialane-io paths (Path 1 untouched)
- [ ] `x-wallet-address` header returns 401 (removed)
- [ ] `requireClerkJwt` rejects `siws_` tokens (gated content stays Clerk-only)
- [ ] Railway deploy applies the `SiwsNonce` migration cleanly
