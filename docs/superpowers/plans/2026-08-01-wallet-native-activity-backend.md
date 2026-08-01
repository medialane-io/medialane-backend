# Wallet-Native Activity — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `medialane-backend` a `GET /v1/wallet-activity` endpoint that lazily
syncs a MediaWallet account's chain-native activity (sends/receives of the 5
supported tokens, swaps, deploy, guardian actions) into Postgres on request,
then serves it from there.

**Architecture:** A pure decode module (event → typed row, no I/O) + a sync
orchestrator (DI-testable: fetch cursor → poll events via the existing
`pollContractEvents` primitive → decode → pair swap legs → upsert → advance
cursor) + a route that runs the sync then reads the cache. Same architectural
slot as `chainRead/index.ts`'s on-demand per-account reads, but this one
writes a cache instead of returning a pure read.

**Tech Stack:** Hono, Prisma v5 + PostgreSQL, Bun test runner, `starknet`
(event selectors, RPC via the existing `callRpc`/`pollContractEvents`
primitives).

## Global Constraints

- Runtime is Bun only — `bun`, never `node`/`npm`/`npx`.
- Always `normalizeAddress("STARKNET", address)` before any DB write or query
  involving an address.
- Chain reads throw on RPC failure; the route surfaces an error, never falls
  back to a stale cache and calls it current (07-identity §V convention).
- `BigInt` for amounts/block numbers in TS; stored as `String`/`BigInt`
  columns per this repo's existing convention.
- Every new field on `schema.prisma` needs a real migration file
  (`bun run db:migrate`) — editing the schema alone does not update prod.
- `{ error: string }` for failures; `{ data: T }` / `{ data: T[], meta }` for
  success — the existing response-shape convention.
- Reuse existing primitives rather than re-deriving them: `pollContractEvents`
  (`src/mirror/poller.ts`), `TRANSFER_SELECTOR` and `SUPPORTED_TOKENS`
  (`src/config/constants.ts`), `mapWithConcurrency` (`src/utils/retry.ts`),
  `identityAuth` (`src/api/middleware/identityAuth.ts`).
- Event selector/calldata layouts below are derived directly from
  `medialane-contracts/contracts/MediaWallet/src/multiowner_account/events.cairo`'s
  visible struct definitions (Cairo Serde: `#[key]`-tagged fields go in
  `event.keys[1..]` in declaration order, everything else in `event.data` in
  declaration order; `event.keys[0]` is always the selector) — not assumed
  from a compiled ABI. Re-verify against a live deployed account if any
  decode test fails against real chain data later.

---

## File Structure

- `prisma/schema.prisma` — add `WalletActivityType` enum, `WalletActivity` +
  `WalletActivityCursor` models.
- `src/config/constants.ts` — add the account-contract event selectors
  (`ACCOUNT_CREATED_GUID_SELECTOR`, etc.) alongside the existing selector
  constants.
- `src/walletActivity/decode.ts` — pure functions: decode one Transfer leg,
  decode one account-contract event, pair swap legs. No I/O, fully
  unit-testable offline.
- `src/walletActivity/sync.ts` — DI-shaped orchestrator (mirrors
  `adminSignatureAuth.ts`'s `Deps` pattern): fetch cursor, poll, decode, pair,
  upsert, advance cursor.
- `src/api/routes/wallet-activity.ts` — the route, DI-shaped the same way as
  `business-provisioning.ts`.
- `src/api/routes/wallet-activity.test.ts` — route-level tests via
  `app.request()` with injected fake deps.
- `src/api/server.ts` — mount the new router.

---

### Task 1: Prisma schema + event selector constants

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/config/constants.ts`
- Create: a migration under `prisma/migrations/` (via `db:migrate`)

**Interfaces:**
- Produces: `WalletActivityType` enum, `WalletActivity` + `WalletActivityCursor`
  models; six new selector constants — consumed by Tasks 2–3.

- [ ] **Step 1: Add the schema**

Add to `prisma/schema.prisma` (near the other single-purpose models):

```prisma
enum WalletActivityType {
  SEND
  RECEIVE
  SWAP
  DEPLOY
  GUARDIAN_SET
  GUARDIAN_TRIGGER_ESCAPE
  GUARDIAN_COMPLETE_ESCAPE
  GUARDIAN_CANCEL_ESCAPE
}

model WalletActivity {
  id              String              @id @default(cuid())
  chain           Chain               @default(STARKNET)
  accountAddress  String
  type            WalletActivityType
  txHash          String
  blockNumber     BigInt
  timestamp       DateTime
  tokenAddress    String?
  amount          String?
  counterparty    String?
  tokenInAddress  String?
  amountIn        String?
  tokenOutAddress String?
  amountOut       String?
  createdAt       DateTime            @default(now())

  @@unique([chain, txHash, type, accountAddress])
  @@index([chain, accountAddress, timestamp])
}

model WalletActivityCursor {
  chain           Chain    @default(STARKNET)
  accountAddress  String
  lastSyncedBlock BigInt
  updatedAt       DateTime @updatedAt

  @@id([chain, accountAddress])
}
```

- [ ] **Step 2: Add the event selector constants**

Add to `src/config/constants.ts`, near the other `hash.getSelectorFromName(...)`
selector constants:

```ts
// MediaWallet account-contract events (multiowner_account/events.cairo) —
// used by wallet-native activity sync, not the bulk protocol indexer.
export const ACCOUNT_CREATED_GUID_SELECTOR = hash.getSelectorFromName("AccountCreatedGuid");
export const GUARDIAN_ADDED_GUID_SELECTOR = hash.getSelectorFromName("GuardianAddedGuid");
export const ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR = hash.getSelectorFromName("EscapeOwnerTriggeredGuid");
export const OWNER_ESCAPED_GUID_SELECTOR = hash.getSelectorFromName("OwnerEscapedGuid");
export const ESCAPE_CANCELED_SELECTOR = hash.getSelectorFromName("EscapeCanceled");
```

- [ ] **Step 3: Generate the migration**

Run: `bun run db:migrate`
Migration name: `add_wallet_activity`
Expected: a new migration directory with the `CREATE TYPE`/`CREATE TABLE`
statements for both models.

- [ ] **Step 4: Regenerate the client and typecheck**

Run: `bun run db:generate && bun run typecheck`
Expected: no errors (no consuming code yet at this point in the plan).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/config/constants.ts
git commit -m "feat: add WalletActivity schema + account event selectors"
```

---

### Task 2: Pure decode module

**Files:**
- Create: `src/walletActivity/decode.ts`
- Test: `src/walletActivity/decode.test.ts`

**Interfaces:**
- Consumes: `RawStarknetEvent` (`src/types/starknet.ts`, existing),
  `TRANSFER_SELECTOR`/`SUPPORTED_TOKENS`/the four account-event selectors
  from Task 1.
- Produces: `decodeTransferLeg`, `decodeAccountEvent`, `pairSwapLegs`,
  `TransferLeg` type — consumed by Task 3.

`Transfer(from, to, value: u256)` is standard OZ ERC-20 Serde: `from`/`to` are
`#[key]` (so `event.keys = [selector, from, to]`), `value` is unkeyed u256
(`event.data = [value_low, value_high]`). This is the universal ERC-20
Transfer shape across Starknet, not specific to any one token contract.

- [ ] **Step 1: Write the failing tests**

```ts
// src/walletActivity/decode.test.ts
import { describe, expect, test } from "bun:test";
import { decodeTransferLeg, decodeAccountEvent, pairSwapLegs, type TransferLeg } from "./decode.js";
import {
  TRANSFER_SELECTOR, ACCOUNT_CREATED_GUID_SELECTOR, GUARDIAN_ADDED_GUID_SELECTOR,
  ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR, OWNER_ESCAPED_GUID_SELECTOR, ESCAPE_CANCELED_SELECTOR,
} from "../config/constants.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const FROM = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TO = "0x0000000000000000000000000000000000000000000000000000000000000002";
const TOKEN = "0x0000000000000000000000000000000000000000000000000000000000000abc";

function baseEvent(overrides: Partial<RawStarknetEvent> = {}): RawStarknetEvent {
  return {
    block_hash: "0xblock", block_number: 100, transaction_hash: "0xtx",
    from_address: TOKEN, keys: [], data: [], ...overrides,
  };
}

describe("decodeTransferLeg", () => {
  test("decodes a standard ERC-20 Transfer event", () => {
    const event = baseEvent({
      keys: [TRANSFER_SELECTOR, FROM, TO],
      data: ["0x64", "0x0"], // value_low=100, value_high=0
    });
    const leg = decodeTransferLeg(event, TOKEN);
    expect(leg).toEqual({
      tokenAddress: TOKEN, from: FROM, to: TO, amount: "100",
      txHash: "0xtx", blockNumber: 100n,
    });
  });

  test("returns null for a non-Transfer event", () => {
    const event = baseEvent({ keys: ["0xnotTransfer", FROM, TO], data: ["0x1", "0x0"] });
    expect(decodeTransferLeg(event, TOKEN)).toBeNull();
  });
});

describe("decodeAccountEvent", () => {
  test("decodes AccountCreatedGuid as DEPLOY", () => {
    const event = baseEvent({ keys: [ACCOUNT_CREATED_GUID_SELECTOR, "0xownerguid"], data: ["0xguardianguid"] });
    expect(decodeAccountEvent(event)).toEqual({ type: "DEPLOY" });
  });

  test("decodes GuardianAddedGuid as GUARDIAN_SET", () => {
    const event = baseEvent({ keys: [GUARDIAN_ADDED_GUID_SELECTOR, "0xguardianguid"], data: [] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_SET" });
  });

  test("decodes EscapeOwnerTriggeredGuid as GUARDIAN_TRIGGER_ESCAPE", () => {
    const event = baseEvent({ keys: [ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR], data: ["0x1234", "0xownerguid"] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_TRIGGER_ESCAPE" });
  });

  test("decodes OwnerEscapedGuid as GUARDIAN_COMPLETE_ESCAPE", () => {
    const event = baseEvent({ keys: [OWNER_ESCAPED_GUID_SELECTOR], data: ["0xownerguid"] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_COMPLETE_ESCAPE" });
  });

  test("decodes EscapeCanceled as GUARDIAN_CANCEL_ESCAPE", () => {
    const event = baseEvent({ keys: [ESCAPE_CANCELED_SELECTOR], data: [] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_CANCEL_ESCAPE" });
  });

  test("returns null for an unrecognized selector", () => {
    expect(decodeAccountEvent(baseEvent({ keys: ["0xsomethingelse"] }))).toBeNull();
  });
});

describe("pairSwapLegs", () => {
  const ACCOUNT = FROM;
  const TOKEN_B = "0x0000000000000000000000000000000000000000000000000000000000000def";

  function leg(overrides: Partial<TransferLeg>): TransferLeg {
    return { tokenAddress: TOKEN, from: ACCOUNT, to: TO, amount: "100", txHash: "0xtx1", blockNumber: 100n, ...overrides };
  }

  test("pairs an outbound + inbound leg on different tokens in the same tx into a swap", () => {
    const out = leg({ tokenAddress: TOKEN, from: ACCOUNT, to: "0xrouter", amount: "100" });
    const inn = leg({ tokenAddress: TOKEN_B, from: "0xrouter", to: ACCOUNT, amount: "50" });
    const { swaps, remaining } = pairSwapLegs([out, inn], ACCOUNT);
    expect(remaining).toHaveLength(0);
    expect(swaps).toEqual([{
      txHash: "0xtx1", blockNumber: 100n,
      tokenInAddress: TOKEN, amountIn: "100",
      tokenOutAddress: TOKEN_B, amountOut: "50",
    }]);
  });

  test("a lone outbound leg (no matching inbound in the same tx) stays a plain transfer", () => {
    const out = leg({ tokenAddress: TOKEN, from: ACCOUNT, to: "0xsomeone", amount: "100", txHash: "0xtx2" });
    const { swaps, remaining } = pairSwapLegs([out], ACCOUNT);
    expect(swaps).toHaveLength(0);
    expect(remaining).toEqual([out]);
  });

  test("two legs of the SAME token in one tx are not paired as a swap", () => {
    const a = leg({ tokenAddress: TOKEN, from: ACCOUNT, to: "0xrouter", amount: "100", txHash: "0xtx3" });
    const b = leg({ tokenAddress: TOKEN, from: "0xrouter", to: ACCOUNT, amount: "90", txHash: "0xtx3" });
    const { swaps, remaining } = pairSwapLegs([a, b], ACCOUNT);
    expect(swaps).toHaveLength(0);
    expect(remaining).toEqual([a, b]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/walletActivity/decode.test.ts`
Expected: FAIL — `./decode.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/walletActivity/decode.ts
import type { RawStarknetEvent } from "../types/starknet.js";
import {
  TRANSFER_SELECTOR, ACCOUNT_CREATED_GUID_SELECTOR, GUARDIAN_ADDED_GUID_SELECTOR,
  ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR, OWNER_ESCAPED_GUID_SELECTOR, ESCAPE_CANCELED_SELECTOR,
} from "../config/constants.js";

export interface TransferLeg {
  tokenAddress: string;
  from: string;
  to: string;
  amount: string;
  txHash: string;
  blockNumber: bigint;
}

/** Standard ERC-20 Transfer: keys = [selector, from, to], data = [value_low, value_high]. */
export function decodeTransferLeg(event: RawStarknetEvent, tokenAddress: string): TransferLeg | null {
  if (event.keys[0] !== TRANSFER_SELECTOR) return null;
  const [from, to] = [event.keys[1], event.keys[2]];
  const [low, high] = [BigInt(event.data[0] ?? "0x0"), BigInt(event.data[1] ?? "0x0")];
  const amount = (low + (high << 128n)).toString();
  return { tokenAddress, from, to, amount, txHash: event.transaction_hash, blockNumber: BigInt(event.block_number) };
}

const ACCOUNT_EVENT_TYPES: Record<string, "DEPLOY" | "GUARDIAN_SET" | "GUARDIAN_TRIGGER_ESCAPE" | "GUARDIAN_COMPLETE_ESCAPE" | "GUARDIAN_CANCEL_ESCAPE"> = {
  [ACCOUNT_CREATED_GUID_SELECTOR]: "DEPLOY",
  [GUARDIAN_ADDED_GUID_SELECTOR]: "GUARDIAN_SET",
  [ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR]: "GUARDIAN_TRIGGER_ESCAPE",
  [OWNER_ESCAPED_GUID_SELECTOR]: "GUARDIAN_COMPLETE_ESCAPE",
  [ESCAPE_CANCELED_SELECTOR]: "GUARDIAN_CANCEL_ESCAPE",
};

/**
 * Recognizes the account-contract events wallet-native activity cares about.
 * EscapeCanceled carries no distinguishing data (`pub struct EscapeCanceled {}`)
 * — an owner-escape cancel and a guardian-escape cancel are indistinguishable
 * from the event alone. Both map to GUARDIAN_CANCEL_ESCAPE; this is a known,
 * accepted limitation, not a bug to chase — self-guardian v1 practically only
 * ever exercises the owner-escape path.
 */
export function decodeAccountEvent(event: RawStarknetEvent): { type: keyof typeof ACCOUNT_EVENT_TYPES } | null {
  const type = ACCOUNT_EVENT_TYPES[event.keys[0]];
  return type ? { type } : null;
}

export interface SwapPair {
  txHash: string;
  blockNumber: bigint;
  tokenInAddress: string;
  amountIn: string;
  tokenOutAddress: string;
  amountOut: string;
}

/**
 * Groups transfer legs by txHash; a tx with exactly one leg OUT of the account
 * and one leg IN to the account, on two different tokens, is a swap. Anything
 * else (a lone leg, same-token legs, more than two legs) stays as individual
 * transfer legs — safer to under-merge than to guess wrong on an unusual tx.
 */
export function pairSwapLegs(legs: TransferLeg[], accountAddress: string): { swaps: SwapPair[]; remaining: TransferLeg[] } {
  const byTx = new Map<string, TransferLeg[]>();
  for (const leg of legs) {
    const group = byTx.get(leg.txHash) ?? [];
    group.push(leg);
    byTx.set(leg.txHash, group);
  }

  const swaps: SwapPair[] = [];
  const remaining: TransferLeg[] = [];
  for (const group of byTx.values()) {
    const outLeg = group.find((l) => l.from === accountAddress);
    const inLeg = group.find((l) => l.to === accountAddress);
    const isSwap = group.length === 2 && outLeg && inLeg && outLeg.tokenAddress !== inLeg.tokenAddress;
    if (isSwap) {
      swaps.push({
        txHash: outLeg.txHash, blockNumber: outLeg.blockNumber,
        tokenInAddress: outLeg.tokenAddress, amountIn: outLeg.amount,
        tokenOutAddress: inLeg.tokenAddress, amountOut: inLeg.amount,
      });
    } else {
      remaining.push(...group);
    }
  }
  return { swaps, remaining };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/walletActivity/decode.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun test src`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/walletActivity/decode.ts src/walletActivity/decode.test.ts
git commit -m "feat: add wallet-native activity event decoders + swap-leg pairing"
```

---

### Task 3: Sync orchestrator

**Files:**
- Create: `src/walletActivity/sync.ts`
- Test: `src/walletActivity/sync.test.ts`

**Interfaces:**
- Consumes: `decodeTransferLeg`, `decodeAccountEvent`, `pairSwapLegs`,
  `TransferLeg` (Task 2); `pollContractEvents` (`src/mirror/poller.ts`,
  existing); `SUPPORTED_TOKENS`, `TRANSFER_SELECTOR`, `START_BLOCK`
  (`src/config/constants.ts`, existing).
- Produces: `SyncDeps` interface, `syncWalletActivity(deps, chain,
  accountAddress): Promise<void>` — consumed by Task 4.

The first sync for an account with no cursor row starts at `START_BLOCK`
(9196722 — the platform's own genesis block; no MediaWallet account can
predate the platform, so this is a real floor, not an arbitrary guess) rather
than scanning from block 0.

- [ ] **Step 1: Write the failing tests**

**Corrected during execution (2026-08-01):** two fixture bugs in the original
version of this test file. (1) The `ACCOUNT` literal was one hex digit short
of the fully-padded 64-char form, so `normalizeAddress` inside
`syncWalletActivity` produced a *different* string than the literal the mocks
compared against — every `params.address === ACCOUNT` check silently failed.
(2) `getLatestBlock` defaulted to `200`, far below `START_BLOCK` (9196722) —
`fromBlock > toBlock` tripped the early-return guard before `pollEvents` was
ever called, so 3 of 4 tests failed with an empty `upserted` array and no
error (the guard is a legitimate no-op-when-nothing-new-to-sync path; the bug
was purely in the fixture). Also replaced the getter-property-on-a-plain-
object `fakeDeps` shape (needed an `as SyncDeps & {...}` cast) with a plain
`{ deps, upserted, getCursorSet }` return — no cast needed, same information:

```ts
// src/walletActivity/sync.test.ts
import { describe, expect, test } from "bun:test";
import { syncWalletActivity, type SyncDeps } from "./sync.js";
import { TRANSFER_SELECTOR, ACCOUNT_CREATED_GUID_SELECTOR, SUPPORTED_TOKENS, START_BLOCK } from "../config/constants.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const ACCOUNT = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const CHAIN = "STARKNET" as const;
const LATEST_BLOCK = START_BLOCK + 100;

function fakeDeps(overrides: Partial<SyncDeps> = {}) {
  const upserted: Array<Record<string, unknown>> = [];
  let cursorSet: bigint | null = null;
  const deps: SyncDeps = {
    getCursor: async () => null,
    getLatestBlock: async () => LATEST_BLOCK,
    pollEvents: async () => [],
    upsertActivities: async (rows) => { upserted.push(...rows); },
    setCursor: async (_chain, _address, block) => { cursorSet = block; },
    ...overrides,
  };
  return { deps, upserted, getCursorSet: () => cursorSet };
}

test("a fresh account (no cursor) syncs from START_BLOCK", async () => {
  let capturedFromBlock: number | undefined;
  const { deps } = fakeDeps({
    pollEvents: async (params) => { capturedFromBlock = params.fromBlock; return []; },
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(capturedFromBlock).toBe(START_BLOCK);
});

test("an existing cursor resumes from lastSyncedBlock + 1", async () => {
  let capturedFromBlock: number | undefined;
  const { deps } = fakeDeps({
    getCursor: async () => ({ lastSyncedBlock: 150n }),
    pollEvents: async (params) => { capturedFromBlock = params.fromBlock; return []; },
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(capturedFromBlock).toBe(151);
});

test("decodes a plain transfer into an upserted SEND row and advances the cursor", async () => {
  const token = SUPPORTED_TOKENS[0].address;
  const transferEvent: RawStarknetEvent = {
    block_hash: "0xb", block_number: 175, transaction_hash: "0xtx",
    from_address: token, keys: [TRANSFER_SELECTOR, ACCOUNT, "0xsomeone"], data: ["0x64", "0x0"],
  };
  const { deps, upserted, getCursorSet } = fakeDeps({
    pollEvents: async (params) => (params.address === token ? [transferEvent] : []),
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(upserted).toHaveLength(1);
  expect(upserted[0]).toMatchObject({ type: "SEND", tokenAddress: token, amount: "100", accountAddress: ACCOUNT });
  expect(getCursorSet()).toBe(BigInt(LATEST_BLOCK));
});

test("decodes an account-contract event into a DEPLOY row", async () => {
  const deployEvent: RawStarknetEvent = {
    block_hash: "0xb", block_number: 175, transaction_hash: "0xtx2",
    from_address: ACCOUNT, keys: [ACCOUNT_CREATED_GUID_SELECTOR, "0xownerguid"], data: ["0x0"],
  };
  const { deps, upserted } = fakeDeps({
    pollEvents: async (params) => (params.address === ACCOUNT ? [deployEvent] : []),
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(upserted).toHaveLength(1);
  expect(upserted[0]).toMatchObject({ type: "DEPLOY", accountAddress: ACCOUNT, txHash: "0xtx2" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/walletActivity/sync.test.ts`
Expected: FAIL — `./sync.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/walletActivity/sync.ts
import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { normalizeAddress } from "../utils/starknet.js";
import { pollContractEvents } from "../mirror/poller.js";
import { SUPPORTED_TOKENS, TRANSFER_SELECTOR, START_BLOCK } from "../config/constants.js";
import { decodeTransferLeg, decodeAccountEvent, pairSwapLegs, type TransferLeg } from "./decode.js";
import { mapWithConcurrency } from "../utils/retry.js";
import type { RawStarknetEvent } from "../types/starknet.js";

export interface SyncDeps {
  getCursor: (chain: Chain, accountAddress: string) => Promise<{ lastSyncedBlock: bigint } | null>;
  getLatestBlock: () => Promise<number>;
  pollEvents: (params: { address: string; fromBlock: number; toBlock: number; keys: string[][] }) => Promise<RawStarknetEvent[]>;
  upsertActivities: (rows: Array<Record<string, unknown>>) => Promise<void>;
  setCursor: (chain: Chain, accountAddress: string, block: bigint) => Promise<void>;
}

const TOKEN_POLL_CONCURRENCY = 4;

export async function syncWalletActivity(deps: SyncDeps, chain: Chain, accountAddressRaw: string): Promise<void> {
  const accountAddress = normalizeAddress(chain, accountAddressRaw);
  const cursor = await deps.getCursor(chain, accountAddress);
  const fromBlock = cursor ? Number(cursor.lastSyncedBlock) + 1 : START_BLOCK;
  const toBlock = await deps.getLatestBlock();
  if (fromBlock > toBlock) return;

  // Two queries per token: one for legs OUT of the account (keys[1]=account),
  // one for legs IN to it (keys[1]=any via [], keys[2]=account) — Starknet's
  // getEvents keys filter is positional-OR-within-position, not OR-across-
  // positions, so "from OR to = account" needs two calls.
  const tokenEvents = (
    await mapWithConcurrency(SUPPORTED_TOKENS, TOKEN_POLL_CONCURRENCY, async (token) => {
      const [outLegs, inLegs] = await Promise.all([
        deps.pollEvents({ address: token.address, fromBlock, toBlock, keys: [[TRANSFER_SELECTOR], [accountAddress]] }),
        deps.pollEvents({ address: token.address, fromBlock, toBlock, keys: [[TRANSFER_SELECTOR], [], [accountAddress]] }),
      ]);
      return [...outLegs, ...inLegs].map((event) => ({ event, tokenAddress: token.address }));
    })
  ).flat();

  const accountEvents = await deps.pollEvents({ address: accountAddress, fromBlock, toBlock, keys: [] });

  const legs: TransferLeg[] = [];
  const seenTxType = new Set<string>();
  for (const { event, tokenAddress } of tokenEvents) {
    const leg = decodeTransferLeg(event, tokenAddress);
    if (!leg) continue;
    const dedupeKey = `${leg.txHash}:${tokenAddress}:${leg.from}:${leg.to}`;
    if (seenTxType.has(dedupeKey)) continue; // the two-query fan-out can return the same leg twice
    seenTxType.add(dedupeKey);
    legs.push(leg);
  }

  const { swaps, remaining } = pairSwapLegs(legs, accountAddress);

  const rows: Array<Record<string, unknown>> = [];
  for (const leg of remaining) {
    rows.push({
      chain, accountAddress, type: leg.from === accountAddress ? "SEND" : "RECEIVE",
      txHash: leg.txHash, blockNumber: leg.blockNumber, timestamp: new Date(),
      tokenAddress: leg.tokenAddress, amount: leg.amount,
      counterparty: leg.from === accountAddress ? leg.to : leg.from,
    });
  }
  for (const swap of swaps) {
    rows.push({
      chain, accountAddress, type: "SWAP",
      txHash: swap.txHash, blockNumber: swap.blockNumber, timestamp: new Date(),
      tokenInAddress: swap.tokenInAddress, amountIn: swap.amountIn,
      tokenOutAddress: swap.tokenOutAddress, amountOut: swap.amountOut,
    });
  }
  for (const event of accountEvents) {
    const decoded = decodeAccountEvent(event);
    if (!decoded) continue;
    rows.push({
      chain, accountAddress, type: decoded.type,
      txHash: event.transaction_hash, blockNumber: BigInt(event.block_number), timestamp: new Date(),
    });
  }

  if (rows.length > 0) await deps.upsertActivities(rows);
  await deps.setCursor(chain, accountAddress, BigInt(toBlock));
}

const productionDeps: SyncDeps = {
  getCursor: (chain, accountAddress) => prisma.walletActivityCursor.findUnique({ where: { chain_accountAddress: { chain, accountAddress } } }),
  getLatestBlock: async () => {
    const { callRpc } = await import("../utils/starknet.js");
    return callRpc((provider) => provider.getBlockLatestAccepted().then((b) => b.block_number));
  },
  pollEvents: pollContractEvents,
  upsertActivities: async (rows) => {
    for (const row of rows) {
      await prisma.walletActivity.upsert({
        where: {
          chain_txHash_type_accountAddress: {
            chain: row.chain as Chain, txHash: row.txHash as string,
            type: row.type as never, accountAddress: row.accountAddress as string,
          },
        },
        create: row as never,
        update: row as never,
      });
    }
  },
  setCursor: (chain, accountAddress, lastSyncedBlock) =>
    prisma.walletActivityCursor.upsert({
      where: { chain_accountAddress: { chain, accountAddress } },
      create: { chain, accountAddress, lastSyncedBlock },
      update: { lastSyncedBlock },
    }).then(() => undefined),
};

export function syncWalletActivityProd(chain: Chain, accountAddress: string): Promise<void> {
  return syncWalletActivity(productionDeps, chain, accountAddress);
}
```

Note on `chain_accountAddress` as the `WalletActivityCursor` compound key
name: Prisma generates it from the `@@id([chain, accountAddress])` field
order declared in Task 1 — if `db:generate` produces a different generated
name, use whatever it actually generated (check `node_modules/@prisma/client`
types or the Prisma error message) rather than guessing further.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/walletActivity/sync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun test src`
Expected: clean. If `chain_accountAddress` (or the upsert `where` shape)
doesn't match what Prisma actually generated, fix the key name here — this is
exactly the kind of mismatch typecheck will catch immediately.

- [ ] **Step 6: Commit**

```bash
git add src/walletActivity/sync.ts src/walletActivity/sync.test.ts
git commit -m "feat: add wallet-native activity sync orchestrator"
```

---

### Task 4: Route + mount

**Files:**
- Create: `src/api/routes/wallet-activity.ts`
- Test: `src/api/routes/wallet-activity.test.ts`
- Modify: `src/api/server.ts`

**Interfaces:**
- Consumes: `syncWalletActivityProd` (Task 3, production path only — the
  route's own tests inject a fake sync function, not the real one).
- Produces: `GET /v1/wallet-activity?address=&chain=`.

Identity-scoped: the route requires `identityAuth` and the JWT-authenticated
wallet must match the queried `address` (same 403-on-mismatch pattern as
`claims.ts`'s `POST /v1/collections/claim`) — this is a personal activity
feed, not a public read.

- [ ] **Step 1: Write the failing tests**

```ts
// src/api/routes/wallet-activity.test.ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createWalletActivityRoutes, type WalletActivityDeps } from "./wallet-activity.js";

function makeApp(deps: WalletActivityDeps, walletAddress = "0xabc") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("walletAddress", walletAddress);
    c.set("account", { id: "acc-1", plan: "FREE", status: "ACTIVE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/wallet-activity", createWalletActivityRoutes(deps));
  return app;
}

test("syncs then returns the caller's own activity", async () => {
  let synced = false;
  const deps: WalletActivityDeps = {
    sync: async () => { synced = true; },
    listActivity: async () => [{ id: "a1", type: "SEND", txHash: "0xtx" } as never],
  };
  const app = makeApp(deps);
  const res = await app.request("/v1/wallet-activity?address=0xabc");
  expect(res.status).toBe(200);
  expect(synced).toBe(true);
  const body = (await res.json()) as { data: unknown[] };
  expect(body.data).toHaveLength(1);
});

test("403s when the queried address doesn't match the authenticated wallet", async () => {
  const deps: WalletActivityDeps = { sync: async () => {}, listActivity: async () => [] };
  const app = makeApp(deps, "0xabc");
  const res = await app.request("/v1/wallet-activity?address=0xdifferent");
  expect(res.status).toBe(403);
});

test("400s when address is missing", async () => {
  const deps: WalletActivityDeps = { sync: async () => {}, listActivity: async () => [] };
  const app = makeApp(deps);
  const res = await app.request("/v1/wallet-activity");
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/routes/wallet-activity.test.ts`
Expected: FAIL — `./wallet-activity.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/api/routes/wallet-activity.ts
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import type { Chain } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { syncWalletActivityProd } from "../../walletActivity/sync.js";

export interface WalletActivityDeps {
  sync: (chain: Chain, accountAddress: string) => Promise<void>;
  listActivity: (chain: Chain, accountAddress: string) => Promise<unknown[]>;
}

export function createWalletActivityRoutes(deps: WalletActivityDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", identityAuth, async (c) => {
    const addressParam = c.req.query("address");
    if (!addressParam) return c.json({ error: "address is required" }, 400);
    const chain = (c.req.query("chain") as Chain | undefined) ?? "STARKNET";
    const address = normalizeAddress(chain, addressParam);

    const jwtWallet = c.get("walletAddress") as string;
    if (jwtWallet !== address) return c.json({ error: "Wallet address does not match authenticated session" }, 403);

    await deps.sync(chain, address);
    const rows = await deps.listActivity(chain, address);
    return c.json({ data: rows });
  });

  return app;
}

const productionDeps: WalletActivityDeps = {
  sync: syncWalletActivityProd,
  listActivity: (chain, accountAddress) =>
    prisma.walletActivity.findMany({ where: { chain, accountAddress }, orderBy: { timestamp: "desc" } }),
};

export const walletActivityRoutes = createWalletActivityRoutes(productionDeps);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/routes/wallet-activity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mount in `src/api/server.ts`**

Add the import near the other route imports:

```ts
import { walletActivityRoutes } from "./routes/wallet-activity.js";
```

Add the mount near the other `/v1/*` route mounts:

```ts
  app.route("/v1/wallet-activity", walletActivityRoutes);
```

No `apiKeyGate` public-path change needed — this route stays behind the
standard `/v1/*` gate (api key + `identityAuth` on top), unlike the
business-provisioning claim routes.

- [ ] **Step 6: Full suite + typecheck**

Run: `bun test src && bun run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/wallet-activity.ts src/api/routes/wallet-activity.test.ts src/api/server.ts
git commit -m "feat: add GET /v1/wallet-activity route"
```

---

## Self-Review Notes

- **Spec coverage:** design spec §3 (data model) → Task 1. §4 (sync logic,
  including the swap-pairing rule and the account-event sources) → Tasks 2–3.
  §5 (API, lazy-only sync-then-read) → Task 4. §6 (errors throw, never
  silently stale) → satisfied by construction: every `deps` call in
  `syncWalletActivity` propagates rejections; nothing catches and swallows.
- **Deviation from the spec, and why:** §4 step 1 said the starting block for
  a fresh cursor is "the account's own deploy block, looked up once." This
  plan uses the platform's `START_BLOCK` (9196722) instead — simpler, avoids
  a separate deploy-block-lookup RPC path, and still correct (no MediaWallet
  account predates the platform). Worth a quick confirmation this tradeoff is
  acceptable before merging Task 3, since it's a real (if minor) divergence
  from the written spec, not just a mechanical fill-in.
- **§8.1-equivalent naming discipline:** this plan doesn't touch any public
  repo with a client-facing naming concern (wallet-activity is backend-only,
  chain-neutral field names) — not applicable here the way it was for
  business-provisioning.
- **Left for the follow-up client-integration plan** (per the spec's own
  §7 scope note): media-wallet/io wiring, retiring the local
  `activity.ts` log, and the UI-layer merge with `/v1/activities`.
