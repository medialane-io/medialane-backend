# Dual-Standard (ERC721 + ERC1155) Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all correctness bugs, design-debt issues, and code-quality problems identified in the post-sprint audit of `medialane-backend` and `medialane-sdk` after the dual-standard ERC721+ERC1155 integration.

**Architecture:** Changes are grouped by priority: Critical (C) fixes land first as isolated commits, followed by shared-utility consolidation in the SDK that unlocks further refactors, then design-gap features (makeOffer1155, checkoutCart1155), then backend robustness improvements (startup recovery), and finally cleanup across both repos.

**Tech Stack:** Bun runtime (`~/.bun/bin/bun`), Hono (backend), Prisma+PostgreSQL (backend), starknet.js v6, tsup (SDK build), Zod (validation), TypeScript strict.

---

## File Map

### medialane-sdk (`/Users/kalamaha/dev/medialane-sdk`)

| Status | Path | Change |
|--------|------|--------|
| Modify | `src/types/marketplace.ts` | Add `paymentToken`+`totalPrice` to `FulfillOrderParams`; add `MakeOffer1155Params`; add `quantity?` to `CartItem` |
| Modify | `src/marketplace/orders.ts` | Fix `fulfillOrder` approve; align `start_time` buffer; import shared utils; remove duplicated helpers |
| Modify | `src/marketplace1155/orders.ts` | Fix `start_time` zero; import shared utils; remove duplicated helpers; add `makeOffer1155`; add `checkoutCart1155` |
| Create | `src/marketplace/errors.ts` | `MedialaneError` class (moved from `orders.ts`) |
| Create | `src/marketplace/utils.ts` | `toSignatureArray`, `getChainId`, `resolveToken`, `getProvider`, `START_TIME_BUFFER_SECS` |
| Create | `src/utils/bytearray.ts` | UTF-8–safe `encodeByteArray` |
| Modify | `src/marketplace/index.ts` | Re-export `MedialaneError` from new `errors.ts` |
| Modify | `src/marketplace1155/index.ts` | Expose `makeOffer`, `checkoutCart` |
| Modify | `src/client.ts` | Mount `erc1155Collection` under `services` |
| Modify | `src/index.ts` | Export `MakeOffer1155Params` |

### medialane-backend (`/Users/kalamaha/dev/medialane-backend`)

| Status | Path | Change |
|--------|------|--------|
| Modify | `src/api/routes/intents.ts` | Add ERC1155 guard to checkout; add counter-offer ERC1155 guard; use `Prisma.InputJsonValue`; rename `counterPrice`→`priceRaw` in schema |
| Modify | `src/orchestrator/intent.ts` | Spread `SNIP12_TYPES_1155`; spread `CANCELLATION_TYPES_1155` |
| Modify | `src/orchestrator/startupRecovery.ts` | Re-enqueue PENDING tokens + collections on startup |
| Modify | `src/types/marketplace.ts` | Fix `OfferItem.item_type: string` (remove numeric `ItemType` from the field) |

---

## Phase 1 — Immediate (Critical Fixes)

### Task 1: Fix SDK `fulfillOrder` missing ERC20 approve call (C1)

> This is a live correctness bug. Every ERC721 buyer using `client.marketplace.fulfillOrder()` will get an on-chain failure because no payment approval is sent.

**Files:**
- Modify: `src/types/marketplace.ts` (add fields to `FulfillOrderParams`)
- Modify: `src/marketplace/orders.ts` (prepend approve call in `fulfillOrder`)

- [ ] **Step 1: Add `paymentToken` and `totalPrice` to `FulfillOrderParams`**

  In `src/types/marketplace.ts`, replace lines 60–62:
  ```ts
  // BEFORE
  export interface FulfillOrderParams {
    orderHash: string;
  }
  ```
  With:
  ```ts
  export interface FulfillOrderParams {
    orderHash: string;
    /** ERC-20 payment token address — the consideration token on the listing. */
    paymentToken: string;
    /** Total price in raw token units as a string (e.g. "1000000" for 1 USDC). */
    totalPrice: string;
  }
  ```

- [ ] **Step 2: Update `fulfillOrder` to prepend the approve call**

  In `src/marketplace/orders.ts`, replace the entire `fulfillOrder` function (lines 292–330) with:
  ```ts
  export async function fulfillOrder(
    account: AccountInterface,
    params: FulfillOrderParams,
    config: ResolvedConfig
  ): Promise<TxResult> {
    const { orderHash, paymentToken, totalPrice } = params;
    const { contract, provider } = makeContract(config);

    const currentNonce = await contract.nonces(account.address);
    const chainId = getChainId(config);

    const fulfillmentParams = {
      order_hash: orderHash,
      fulfiller: account.address,
      nonce: currentNonce.toString(),
    };

    const typedData = stringifyBigInts(
      buildFulfillmentTypedData(fulfillmentParams, chainId)
    ) as TypedData;

    const signature = await account.signMessage(typedData);
    const signatureArray = toSignatureArray(signature);

    const fulfillPayload = stringifyBigInts({
      fulfillment: fulfillmentParams,
      signature: signatureArray,
    }) as Record<string, unknown>;

    const totalPriceU256 = cairo.uint256(totalPrice);
    const approveCall = {
      contractAddress: paymentToken,
      entrypoint: "approve",
      calldata: [
        config.marketplaceContract,
        totalPriceU256.low.toString(),
        totalPriceU256.high.toString(),
      ],
    };

    const fulfillCall = contract.populate("fulfill_order", [fulfillPayload]);

    try {
      const tx = await account.execute([approveCall, fulfillCall]);
      await provider.waitForTransaction(tx.transaction_hash);
      return { txHash: tx.transaction_hash };
    } catch (err) {
      throw new MedialaneError("Failed to fulfill order", "TRANSACTION_FAILED", err);
    }
  }
  ```

- [ ] **Step 3: Typecheck**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk && ~/.bun/bin/bun run typecheck
  ```
  Expected: 0 errors.

- [ ] **Step 4: Build**

  ```bash
  ~/.bun/bin/bun run build
  ```
  Expected: build completes with `dist/` output, no errors.

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  git add src/types/marketplace.ts src/marketplace/orders.ts
  git commit -m "fix(sdk): add ERC20 approve to fulfillOrder — was missing payment approval before fulfill_order call"
  ```

---

### Task 2: Fix SDK ERC1155 `createListing1155` zero `start_time` buffer (C2)

> `start_time = now` with no buffer can cause immediate rejection on-chain if tx inclusion lags even one second.

**Files:**
- Modify: `src/marketplace1155/orders.ts` (line 126)

- [ ] **Step 1: Add 30-second buffer to `start_time`**

  In `src/marketplace1155/orders.ts`, find the `orderParams` construction inside `createListing1155`. Change:
  ```ts
  start_time: now.toString(),
  ```
  To:
  ```ts
  start_time: (now + 30).toString(),
  ```

- [ ] **Step 2: Typecheck**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk && ~/.bun/bin/bun run typecheck
  ```
  Expected: 0 errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/marketplace1155/orders.ts
  git commit -m "fix(sdk): add 30s start_time buffer to createListing1155 — was zero, risking immediate on-chain rejection"
  ```

---

### Task 3: Fix backend checkout endpoint silently routing ERC1155 orders to ERC721 (C5)

> `POST /v1/intents/checkout` calls `buildFulfillOrderIntent` with no `tokenStandard` hint. Non-indexed ERC1155 orders default to ERC721 routing (wrong contract, wrong SNIP-12 domain). Per-order errors are swallowed silently.

**Files:**
- Modify: `src/api/routes/intents.ts` (checkout handler, around line 400)

- [ ] **Step 1: Add pre-flight DB check inside the checkout loop**

  In `src/api/routes/intents.ts`, find the `for (const orderHash of orderHashes)` loop (around line 402). Add a guard at the top of the loop body, before calling `buildFulfillOrderIntent`:

  ```ts
  for (const orderHash of orderHashes) {
    try {
      // Guard: mirror the single-fulfill check — if the order isn't indexed yet,
      // we cannot safely determine ERC721 vs ERC1155 routing.
      const dbOrder = await prisma.order.findUnique({
        where: { orderHash },
        select: { id: true },
      });
      if (!dbOrder) {
        results.push({
          orderHash,
          error: "Order not found in index — cannot determine token standard for checkout",
        });
        continue;
      }

      const { typedData, calls } = await buildFulfillOrderIntent({
        fulfiller: normalizeAddress(fulfiller),
        orderHash,
      });
      // ... rest of existing code unchanged
  ```

  The `results.push(...)` at the end of the catch block (the generic error fallback) stays unchanged.

- [ ] **Step 2: Verify backend starts cleanly**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3
  curl -s http://localhost:3000/health | head -c 200
  ```
  Expected: JSON with `{ "status": "ok" ... }`.

- [ ] **Step 3: Curl the checkout endpoint with an unknown order hash**

  ```bash
  curl -s -X POST http://localhost:3000/v1/intents/checkout \
    -H "Content-Type: application/json" \
    -H "x-api-key: <any_test_key>" \
    -d '{"fulfiller":"0x1234","orderHashes":["0xdeadbeef"]}' | python3 -m json.tool
  ```
  Expected: `201` response with `data[0].error` containing `"Order not found in index"` (not a 500).

- [ ] **Step 4: Kill dev server and commit**

  ```bash
  kill %1 2>/dev/null; true
  cd /Users/kalamaha/dev/medialane-backend
  git add src/api/routes/intents.ts
  git commit -m "fix(api): checkout endpoint now guards against ERC1155→ERC721 misrouting for non-indexed orders"
  ```

---

### Task 4: Guard counter-offer endpoint against ERC1155 orders (C6)

> `POST /v1/intents/counter-offer` calls `buildCounterOfferIntent` which always uses ERC721 contract and SNIP-12 domain v1. An ERC1155 bid passes the existing guard and receives silently incorrect typed data.

**Files:**
- Modify: `src/api/routes/intents.ts` (counter-offer handler, around line 172)

- [ ] **Step 1: Add ERC1155 rejection guard**

  In `src/api/routes/intents.ts`, in the counter-offer handler after the `if (!originalOrder)` check (around line 173), add:

  ```ts
  if (!originalOrder) {
    return c.json({ error: "Original order not found or not active" }, 400);
  }

  // Counter-offer only supported for ERC-721 orders — ERC-1155 requires a separate flow.
  if (originalOrder.considerationItemType === "ERC1155") {
    return c.json({ error: "Counter-offer is not supported for ERC-1155 orders" }, 400);
  }
  ```

- [ ] **Step 2: Verify backend compiles and starts**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```
  Expected: `"status":"ok"`.

- [ ] **Step 3: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/api/routes/intents.ts
  git commit -m "fix(api): reject counter-offer attempts on ERC-1155 orders — was silently building wrong typed data"
  ```

---

## Phase 2 — This Sprint

### Task 5: Add UTF-8–safe `encodeByteArray` to SDK (C4)

> `byteArray.byteArrayFromString` from starknet.js uses `encodeShortString` internally which throws on non-ASCII characters. Creator names with accented letters, CJK, or Arabic will fail in `mint()` and `createCollection()`.

**Files:**
- Create: `src/utils/bytearray.ts`
- Modify: `src/marketplace/orders.ts` (replace local `encodeByteArray`)

- [ ] **Step 1: Create `src/utils/bytearray.ts`**

  ```ts
  import { num } from "starknet";

  /**
   * Serialize a string as Cairo ByteArray calldata felts using UTF-8 encoding.
   *
   * starknet.js byteArray.byteArrayFromString calls encodeShortString internally
   * and rejects non-ASCII characters. This implementation packs raw UTF-8 bytes
   * into 31-byte chunks as big-endian felts, matching the Cairo ByteArray struct.
   *
   * Return layout: [chunks_len, ...chunk_felts, pending_word, pending_word_len]
   */
  export function encodeByteArray(str: string): string[] {
    const bytes = new TextEncoder().encode(str);
    const fullChunks: string[] = [];

    let i = 0;
    while (i + 31 <= bytes.length) {
      let val = 0n;
      for (const b of bytes.slice(i, i + 31)) {
        val = (val << 8n) | BigInt(b);
      }
      fullChunks.push(num.toHex(val));
      i += 31;
    }

    const remaining = bytes.slice(i);
    let pendingVal = 0n;
    for (const b of remaining) {
      pendingVal = (pendingVal << 8n) | BigInt(b);
    }

    return [
      fullChunks.length.toString(),
      ...fullChunks,
      num.toHex(pendingVal),
      remaining.length.toString(),
    ];
  }
  ```

- [ ] **Step 2: Replace local `encodeByteArray` in `src/marketplace/orders.ts`**

  Add this import near the top of `orders.ts` (with the other utils imports):
  ```ts
  import { encodeByteArray } from "../utils/bytearray.js";
  ```

  Delete the existing `encodeByteArray` function (lines 376–384):
  ```ts
  // DELETE THIS ENTIRE FUNCTION:
  function encodeByteArray(str: string): string[] {
    const ba = byteArray.byteArrayFromString(str);
    return [
      ba.data.length.toString(),
      ...ba.data.map((d) => num.toHex(d)),
      num.toHex(ba.pending_word),
      ba.pending_word_len.toString(),
    ];
  }
  ```

  Also remove unused imports `byteArray` and `num` from the starknet import at line 1 if they are no longer used. The import currently reads:
  ```ts
  import {
    type AccountInterface,
    type Abi,
    Contract,
    RpcProvider,
    cairo,
    byteArray,
    num,
    shortString,
    constants,
    type TypedData,
  } from "starknet";
  ```
  Remove `byteArray` and `num` from the import (they are only used in the deleted function). Keep `cairo`, `shortString`, and the rest.

- [ ] **Step 3: Export `encodeByteArray` from the SDK index**

  In `src/index.ts`, find the Utils exports section (around line 59) and add:
  ```ts
  export { encodeByteArray } from "./utils/bytearray.js";
  ```

- [ ] **Step 4: Typecheck and build**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun run build
  ```
  Expected: 0 type errors, build completes.

- [ ] **Step 5: Commit**

  ```bash
  git add src/utils/bytearray.ts src/marketplace/orders.ts src/index.ts
  git commit -m "fix(sdk): replace starknet.js encodeByteArray with UTF-8-safe implementation — fixes non-ASCII collection names"
  ```

---

### Task 6: Create shared marketplace utilities (I1 + I2 + C3)

> `toSignatureArray`, `getChainId`, and `resolveToken` are duplicated verbatim between `marketplace/orders.ts` and `marketplace1155/orders.ts`. The RPC provider cache is also split, creating two connections for one client. This task consolidates everything and also aligns the `start_time` buffer via a shared constant (C3).

**Files:**
- Create: `src/marketplace/errors.ts`
- Create: `src/marketplace/utils.ts`
- Modify: `src/marketplace/orders.ts`
- Modify: `src/marketplace1155/orders.ts`
- Modify: `src/marketplace/index.ts`

- [ ] **Step 1: Create `src/marketplace/errors.ts`**

  Move `MedialaneError` out of `orders.ts` into its own file to avoid a circular dependency (utils imports MedialaneError, orders imports utils):

  ```ts
  import type { MedialaneErrorCode } from "../types/errors.js";

  export class MedialaneError extends Error {
    constructor(
      message: string,
      public readonly code: MedialaneErrorCode = "UNKNOWN",
      public readonly cause?: unknown
    ) {
      super(message);
      this.name = "MedialaneError";
    }
  }
  ```

- [ ] **Step 2: Create `src/marketplace/utils.ts`**

  ```ts
  import { RpcProvider, constants } from "starknet";
  import type { ResolvedConfig } from "../config.js";
  import { SUPPORTED_TOKENS, DEFAULT_CURRENCY } from "../constants.js";
  import { MedialaneError } from "./errors.js";

  export { DEFAULT_CURRENCY };

  /** Seconds added to current unix time when setting order `start_time`.
   *  Provides buffer for Starknet tx inclusion (~6s blocks, 30s is one full block cycle). */
  export const START_TIME_BUFFER_SECS = 30;

  export function toSignatureArray(sig: unknown): string[] {
    if (Array.isArray(sig)) return sig as string[];
    const s = sig as { r: bigint | string; s: bigint | string };
    return [s.r.toString(), s.s.toString()];
  }

  export function getChainId(_config: ResolvedConfig): constants.StarknetChainId {
    return constants.StarknetChainId.SN_MAIN;
  }

  export function resolveToken(currency: string) {
    const token = SUPPORTED_TOKENS.find(
      (t) => t.symbol === currency.toUpperCase() || t.address.toLowerCase() === currency.toLowerCase()
    );
    if (!token) throw new MedialaneError(`Unsupported currency: ${currency}`, "INVALID_PARAMS");
    return token;
  }

  const _providerCache = new WeakMap<ResolvedConfig, RpcProvider>();

  export function getProvider(config: ResolvedConfig): RpcProvider {
    let p = _providerCache.get(config);
    if (!p) {
      p = new RpcProvider({ nodeUrl: config.rpcUrl });
      _providerCache.set(config, p);
    }
    return p;
  }
  ```

- [ ] **Step 3: Update `src/marketplace/orders.ts` — remove duplicates, import from utils**

  At the top of `orders.ts`, replace the existing class definition and helpers:

  a) Remove the `MedialaneError` class definition (lines 35–44).

  b) Remove the `toSignatureArray` function (lines 46–50).

  c) Remove the `getChainId` function (lines 52–54).

  d) Remove the `_contractCache`, `_providerCache` WeakMaps and the `getProvider` function (lines 56–66).

  e) Remove the `resolveToken` function (lines 83–89).

  f) Add these imports at the top:
  ```ts
  import { MedialaneError } from "./errors.js";
  import {
    toSignatureArray,
    getChainId,
    getProvider,
    resolveToken,
    START_TIME_BUFFER_SECS,
  } from "./utils.js";
  ```

  g) Update the `createListing` start_time (line ~107) from `now + 300` to `now + START_TIME_BUFFER_SECS`.

  h) Update the `makeOffer` start_time (line ~215) from `now + 300` to `now + START_TIME_BUFFER_SECS`.

  i) The `_contractCache` WeakMap for the ERC721 contract stays in `orders.ts` (it caches a specific `Contract` instance with `IPMarketplaceABI`). Only the `_providerCache` moves to `utils.ts`. Update `makeContract` to use `getProvider` from utils:
  ```ts
  const _contractCache = new WeakMap<ResolvedConfig, { contract: Contract; provider: RpcProvider }>();

  function makeContract(config: ResolvedConfig): { contract: Contract; provider: RpcProvider } {
    const cached = _contractCache.get(config);
    if (cached) return cached;

    const provider = getProvider(config);
    const contract = new Contract(
      IPMarketplaceABI as unknown as Abi,
      config.marketplaceContract,
      provider
    );
    const result = { contract, provider };
    _contractCache.set(config, result);
    return result;
  }
  ```

  Note: remove the `RpcProvider` import from starknet (it's now in utils). Keep `Contract`, `cairo`, `shortString`, `constants`, `TypedData`, `AccountInterface`, `Abi`.

- [ ] **Step 4: Update `src/marketplace1155/orders.ts` — remove duplicates, import from utils**

  a) Remove `toSignatureArray` (lines 28–32).

  b) Remove `getChainId` (lines 34–36).

  c) Remove the `_providerCache` WeakMap and `getProvider` function (lines 38–48).

  d) Remove `resolveToken` (lines 64–70).

  e) Change the `MedialaneError` import from `"../marketplace/orders.js"` to `"../marketplace/errors.js"`.

  f) Add these imports:
  ```ts
  import {
    toSignatureArray,
    getChainId,
    getProvider,
    resolveToken,
    START_TIME_BUFFER_SECS,
  } from "../marketplace/utils.js";
  ```

  g) Update `createListing1155` start_time (was already fixed to `now + 30` in Task 2) to use the constant:
  ```ts
  start_time: (now + START_TIME_BUFFER_SECS).toString(),
  ```

  h) The `_contractCache` for the 1155 contract stays in `orders.ts` (it caches a specific `Contract` with `Medialane1155ABI`). Update `getContract` to use `getProvider` from utils:
  ```ts
  const _contractCache = new WeakMap<ResolvedConfig, Contract>();

  function getContract(config: ResolvedConfig): Contract {
    let c = _contractCache.get(config);
    if (!c) {
      const provider = getProvider(config);
      c = new Contract(
        Medialane1155ABI as unknown as Abi,
        config.marketplace1155Contract,
        provider
      );
      _contractCache.set(config, c);
    }
    return c;
  }
  ```

  i) Remove `RpcProvider` from the starknet import (it's now in utils).

- [ ] **Step 5: Update `src/marketplace/index.ts` — re-export `MedialaneError` from new location**

  In `src/marketplace/index.ts`, change:
  ```ts
  export { MedialaneError } from "./orders.js";
  ```
  To:
  ```ts
  export { MedialaneError } from "./errors.js";
  ```
  Everything else in `index.ts` stays unchanged.

- [ ] **Step 6: Typecheck and build**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun run build
  ```
  Expected: 0 type errors, build completes.

- [ ] **Step 7: Commit**

  ```bash
  git add src/marketplace/errors.ts src/marketplace/utils.ts \
    src/marketplace/orders.ts src/marketplace/index.ts \
    src/marketplace1155/orders.ts
  git commit -m "refactor(sdk): consolidate shared marketplace utils — single provider cache, shared constants, remove duplication"
  ```

---

### Task 7: Mount `ERC1155CollectionService` on `client.services` (I5)

> `ERC1155CollectionService` is exported from the package but not instantiated on `MedialaneClient`, forcing consumers to construct it manually outside the unified client pattern.

**Files:**
- Modify: `src/client.ts`

- [ ] **Step 1: Add `erc1155Collection` to `client.ts`**

  In `src/client.ts`, add this import:
  ```ts
  import { ERC1155CollectionService } from "./services/erc1155collection.js";
  ```

  Update the `services` type:
  ```ts
  readonly services: {
    readonly pop: PopService;
    readonly drop: DropService;
    readonly erc1155Collection: ERC1155CollectionService;
  };
  ```

  Update the constructor assignment:
  ```ts
  this.services = {
    pop: new PopService(this.config),
    drop: new DropService(this.config),
    erc1155Collection: new ERC1155CollectionService(this.config),
  };
  ```

- [ ] **Step 2: Typecheck and build**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun run build
  ```
  Expected: 0 errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/client.ts
  git commit -m "feat(sdk): mount ERC1155CollectionService on client.services.erc1155Collection"
  ```

---

### Task 8: Add `makeOffer` (bid) to `Medialane1155Module` (I6)

> ERC721 supports full marketplace CRUD (list, bid, fulfill, cancel). ERC1155 is missing the bid path. The backend intent flow already supports ERC1155 bids; the SDK on-chain path does not.

**Files:**
- Modify: `src/types/marketplace.ts` (add `MakeOffer1155Params`)
- Modify: `src/marketplace1155/orders.ts` (implement `makeOffer1155`)
- Modify: `src/marketplace1155/index.ts` (expose `makeOffer`)
- Modify: `src/index.ts` (export `MakeOffer1155Params`)

- [ ] **Step 1: Add `MakeOffer1155Params` to `src/types/marketplace.ts`**

  After `CancelOrder1155Params` (around line 130), add:
  ```ts
  export interface MakeOffer1155Params {
    /** ERC-1155 contract address */
    nftContract: string;
    /** Token type ID */
    tokenId: string;
    /** Number of units to bid on */
    amount: string;
    /** Human-readable price per unit (e.g. "1.5" for 1.5 USDC) */
    pricePerUnit: string;
    /** Currency symbol or token address. Defaults to "USDC". */
    currency?: string;
    /** How long the offer is valid, in seconds */
    durationSeconds: number;
  }
  ```

- [ ] **Step 2: Implement `makeOffer1155` in `src/marketplace1155/orders.ts`**

  Add this import at the top (with existing marketplace.ts imports):
  ```ts
  import type {
    CreateListing1155Params,
    FulfillOrder1155Params,
    CancelOrder1155Params,
    MakeOffer1155Params,
    TxResult,
  } from "../types/marketplace.js";
  ```

  Also add the `DEFAULT_CURRENCY` import if not already present (it comes from `../marketplace/utils.js` as re-exported from `../constants.js`):
  ```ts
  import {
    toSignatureArray,
    getChainId,
    getProvider,
    resolveToken,
    START_TIME_BUFFER_SECS,
    DEFAULT_CURRENCY,
  } from "../marketplace/utils.js";
  ```

  Then add the function before the end of the file:
  ```ts
  /**
   * Make an ERC-1155 bid — offerer offers ERC20, asks for ERC1155.
   *
   * Approves payment token then registers an ERC-20→ERC-1155 order on Medialane1155.
   * Uses SNIP-12 domain version "2" and nested OfferItem/ConsiderationItem.
   */
  export async function makeOffer1155(
    account: AccountInterface,
    params: MakeOffer1155Params,
    config: ResolvedConfig
  ): Promise<TxResult> {
    const {
      nftContract,
      tokenId,
      amount,
      pricePerUnit,
      currency = DEFAULT_CURRENCY,
      durationSeconds,
    } = params;

    const contract = getContract(config);
    const provider = getProvider(config);

    const token = resolveToken(currency);
    const priceWei = parseAmount(pricePerUnit, token.decimals);

    const now = Math.floor(Date.now() / 1000);
    const endTime = now + durationSeconds;

    const saltBytes = new Uint8Array(4);
    crypto.getRandomValues(saltBytes);
    const salt = new DataView(saltBytes.buffer).getUint32(0).toString();

    const currentNonce = await contract.nonces(account.address);
    const chainId = getChainId(config);

    const orderParams = {
      offerer: account.address,
      offer: {
        item_type: "ERC20",
        token: token.address,
        identifier_or_criteria: "0",
        start_amount: priceWei,
        end_amount: priceWei,
      },
      consideration: {
        item_type: "ERC1155",
        token: nftContract,
        identifier_or_criteria: tokenId,
        start_amount: amount,
        end_amount: amount,
        recipient: account.address,
      },
      start_time: (now + START_TIME_BUFFER_SECS).toString(),
      end_time: endTime.toString(),
      salt,
      nonce: currentNonce.toString(),
    };

    const typedData = stringifyBigInts(
      build1155OrderTypedData(orderParams, chainId)
    ) as TypedData;

    const signature = await account.signMessage(typedData);
    const signatureArray = toSignatureArray(signature);

    const orderPayload = stringifyBigInts({
      parameters: orderParams,
      signature: signatureArray,
    }) as Record<string, unknown>;

    const priceWeiU256 = cairo.uint256(priceWei);
    const approveCall = {
      contractAddress: token.address,
      entrypoint: "approve",
      calldata: [
        config.marketplace1155Contract,
        priceWeiU256.low.toString(),
        priceWeiU256.high.toString(),
      ],
    };

    const registerCall = contract.populate("register_order", [orderPayload]);

    try {
      const tx = await account.execute([approveCall, registerCall]);
      await provider.waitForTransaction(tx.transaction_hash);
      return { txHash: tx.transaction_hash };
    } catch (err) {
      throw new MedialaneError("Failed to make ERC-1155 offer", "TRANSACTION_FAILED", err);
    }
  }
  ```

- [ ] **Step 3: Expose `makeOffer` on `Medialane1155Module` in `src/marketplace1155/index.ts`**

  Add the import and type:
  ```ts
  import type {
    CreateListing1155Params,
    FulfillOrder1155Params,
    CancelOrder1155Params,
    MakeOffer1155Params,
    TxResult,
  } from "../types/marketplace.js";

  import {
    build1155OrderTypedData,
    build1155FulfillmentTypedData,
    build1155CancellationTypedData,
  } from "./signing.js";

  import {
    createListing1155,
    fulfillOrder1155,
    cancelOrder1155,
    makeOffer1155,
  } from "./orders.js";
  ```

  Add the method to `Medialane1155Module`:
  ```ts
  /**
   * Make an ERC-1155 bid — offerer offers ERC20, asks for ERC1155.
   * Approves payment then registers ERC-20→ERC-1155 order on Medialane1155.
   */
  makeOffer(account: AccountInterface, params: MakeOffer1155Params): Promise<TxResult> {
    return makeOffer1155(account, params, this.config);
  }
  ```
  Place it after `createListing` and before `fulfillOrder`.

- [ ] **Step 4: Export `MakeOffer1155Params` from `src/index.ts`**

  The types are already exported via `export * from "./types/index.js"` and `types/index.ts` re-exports from `types/marketplace.ts`, so no change needed if `types/index.ts` already re-exports all from `types/marketplace.ts`. Verify:

  ```bash
  grep "MakeOffer1155" /Users/kalamaha/dev/medialane-sdk/src/types/index.ts || echo "not re-exported — needs adding"
  ```

  If the output is `not re-exported — needs adding`, open `src/types/index.ts` and confirm it has `export * from "./marketplace.js"`. If it does, the new type is automatically included.

- [ ] **Step 5: Typecheck and build**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun run build
  ```
  Expected: 0 errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/types/marketplace.ts src/marketplace1155/orders.ts src/marketplace1155/index.ts
  git commit -m "feat(sdk): add makeOffer to Medialane1155Module — ERC-1155 bids now supported on-chain"
  ```

---

## Phase 3 — Next Sprint

### Task 9: Fix `SNIP12_TYPES_1155` reference alias in backend (I3)

> `const SNIP12_TYPES_1155 = SNIP12_TYPES` is a live reference — adding a type to `SNIP12_TYPES` in the future silently mutates the ERC1155 domain as well. Same risk in `CANCELLATION_TYPES_1155`.

**Files:**
- Modify: `src/orchestrator/intent.ts` (line 80, 92–95)

- [ ] **Step 1: Replace alias with spread**

  In `src/orchestrator/intent.ts`, replace line 80:
  ```ts
  // BEFORE
  const SNIP12_TYPES_1155 = SNIP12_TYPES;
  ```
  With:
  ```ts
  // V2 uses identical OrderParameters types — deliberate copy, not a live alias.
  const SNIP12_TYPES_1155 = { ...SNIP12_TYPES };
  ```

  Replace lines 92–95:
  ```ts
  // BEFORE
  const CANCELLATION_TYPES_1155 = {
    StarknetDomain: SNIP12_TYPES_1155.StarknetDomain,
    OrderCancellation: CANCELLATION_TYPES.OrderCancellation,
  };
  ```
  With:
  ```ts
  const CANCELLATION_TYPES_1155 = {
    StarknetDomain: [...SNIP12_TYPES_1155.StarknetDomain],
    OrderCancellation: [...CANCELLATION_TYPES.OrderCancellation],
  };
  ```

- [ ] **Step 2: Start dev server to verify no runtime errors**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```
  Expected: `"status":"ok"`.

- [ ] **Step 3: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/orchestrator/intent.ts
  git commit -m "fix(backend): use spread for SNIP12_TYPES_1155 and CANCELLATION_TYPES_1155 — prevents accidental aliasing"
  ```

---

### Task 10: Fix `OfferItem.item_type` type mismatch — remove unused `ItemType` enum (I4)

> `OfferItem.item_type` is typed as `ItemType` (a numeric enum: ERC721=2, ERC1155=3) but every usage in the codebase assigns string values like `"ERC721"`. The type is misleading and wrong.

**Files:**
- Modify: `src/types/marketplace.ts`

- [ ] **Step 1: Change `item_type` to `string` in `OfferItem`, remove enum**

  In `src/types/marketplace.ts`, delete the entire `ItemType` enum (lines 10–15):
  ```ts
  // DELETE THIS:
  export enum ItemType {
    NATIVE = 0,
    ERC20 = 1,
    ERC721 = 2,
    ERC1155 = 3,
  }
  ```

  In the `OfferItem` interface (line 18), change:
  ```ts
  item_type: ItemType;
  ```
  To:
  ```ts
  item_type: string;
  ```

- [ ] **Step 2: Verify no other files import `ItemType`**

  ```bash
  grep -r "ItemType" /Users/kalamaha/dev/medialane-backend/src/ --include="*.ts"
  ```
  Expected: no output (the enum was only defined, never imported elsewhere).

- [ ] **Step 3: Start dev server to verify**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```
  Expected: `"status":"ok"`.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/types/marketplace.ts
  git commit -m "fix(types): remove unused ItemType numeric enum — item_type is always a string shortstring"
  ```

---

### Task 11: Add `checkoutCart` to `Medialane1155Module` (I7)

> Batch purchase of ERC1155 listings is unsupported in the SDK on-chain path. Mirrors the ERC721 `checkoutCart`.

**Files:**
- Modify: `src/types/marketplace.ts` (add `quantity?` to `CartItem`)
- Modify: `src/marketplace1155/orders.ts` (implement `checkoutCart1155`)
- Modify: `src/marketplace1155/index.ts` (expose `checkoutCart`)

- [ ] **Step 1: Add optional `quantity` to `CartItem`**

  In `src/types/marketplace.ts`, update `CartItem` (around line 68):
  ```ts
  export interface CartItem {
    orderHash: string;
    /** ERC-20 token address of the consideration */
    considerationToken: string;
    /** Raw consideration amount per unit (string, e.g. "1000000") */
    considerationAmount: string;
    /** Human-readable identifier for the NFT (for logging) */
    offerIdentifier?: string;
    /** ERC-1155 only: number of units to purchase. Defaults to "1" if omitted. */
    quantity?: string;
  }
  ```

- [ ] **Step 2: Implement `checkoutCart1155` in `src/marketplace1155/orders.ts`**

  Add this import at the top (with existing marketplace.ts type imports):
  ```ts
  import type {
    CreateListing1155Params,
    FulfillOrder1155Params,
    CancelOrder1155Params,
    MakeOffer1155Params,
    CartItem,
    TxResult,
  } from "../types/marketplace.js";
  ```

  Add the function:
  ```ts
  /**
   * Checkout a cart of ERC-1155 orders in a single atomic multicall.
   *
   * Groups ERC-20 approvals by token (sum of consideration amounts), then signs
   * sequential fulfillments (nonce increments per item). The entire multicall
   * either succeeds or reverts atomically.
   *
   * NOTE: The nonce sequence (baseNonce, baseNonce+1, ...) assumes no concurrent
   * fulfill/cancel calls from the same account between nonce fetch and tx execution.
   * Interleaved concurrent operations will cause the entire tx to revert.
   */
  export async function checkoutCart1155(
    account: AccountInterface,
    items: CartItem[],
    config: ResolvedConfig
  ): Promise<TxResult> {
    if (items.length === 0) throw new MedialaneError("Cart is empty", "INVALID_PARAMS");

    const contract = getContract(config);
    const provider = getProvider(config);

    // Sum ERC-20 approval amounts per token address
    const tokenTotals = new Map<string, bigint>();
    for (const item of items) {
      const prev = tokenTotals.get(item.considerationToken) ?? 0n;
      tokenTotals.set(item.considerationToken, prev + BigInt(item.considerationAmount));
    }

    const approveCalls = Array.from(tokenTotals.entries()).map(([tokenAddr, totalWei]) => {
      const amount = cairo.uint256(totalWei.toString());
      return {
        contractAddress: tokenAddr,
        entrypoint: "approve",
        calldata: [
          config.marketplace1155Contract,
          amount.low.toString(),
          amount.high.toString(),
        ],
      };
    });

    const currentNonce = await contract.nonces(account.address);
    const baseNonce = BigInt(currentNonce.toString());
    const chainId = getChainId(config);

    const fulfillCalls = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const nonce = (baseNonce + BigInt(i)).toString();

      const fulfillmentParams = {
        order_hash: item.orderHash,
        fulfiller: account.address,
        quantity: item.quantity ?? "1",
        nonce,
      };

      const typedData = stringifyBigInts(
        build1155FulfillmentTypedData(fulfillmentParams, chainId)
      ) as TypedData;

      const signature = await account.signMessage(typedData);
      const signatureArray = toSignatureArray(signature);

      const fulfillPayload = stringifyBigInts({
        fulfillment: fulfillmentParams,
        signature: signatureArray,
      }) as Record<string, unknown>;

      fulfillCalls.push(contract.populate("fulfill_order", [fulfillPayload]));
    }

    try {
      const tx = await account.execute([...approveCalls, ...fulfillCalls]);
      await provider.waitForTransaction(tx.transaction_hash);
      return { txHash: tx.transaction_hash };
    } catch (err) {
      throw new MedialaneError("ERC-1155 cart checkout failed", "TRANSACTION_FAILED", err);
    }
  }
  ```

- [ ] **Step 3: Expose `checkoutCart` on `Medialane1155Module`**

  In `src/marketplace1155/index.ts`, add the import:
  ```ts
  import {
    createListing1155,
    fulfillOrder1155,
    cancelOrder1155,
    makeOffer1155,
    checkoutCart1155,
  } from "./orders.js";
  ```

  And the type import:
  ```ts
  import type {
    CreateListing1155Params,
    FulfillOrder1155Params,
    CancelOrder1155Params,
    MakeOffer1155Params,
    CartItem,
    TxResult,
  } from "../types/marketplace.js";
  ```

  Add the method to the class:
  ```ts
  /**
   * Checkout a cart of ERC-1155 orders in a single atomic multicall.
   * Each CartItem.quantity defaults to "1" if omitted.
   */
  checkoutCart(account: AccountInterface, items: CartItem[]): Promise<TxResult> {
    return checkoutCart1155(account, items, this.config);
  }
  ```

- [ ] **Step 4: Typecheck and build**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun run build
  ```
  Expected: 0 errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/types/marketplace.ts src/marketplace1155/orders.ts src/marketplace1155/index.ts
  git commit -m "feat(sdk): add checkoutCart to Medialane1155Module — batch ERC-1155 order fulfillment"
  ```

---

### Task 12: Extend startup recovery to re-enqueue pending work (I8 + M6)

> On restart, the in-memory worker queue is empty. Tokens and collections stuck at `PENDING` metadataStatus will never be processed unless the normal retry loop picks them up. This adds an explicit re-enqueue sweep on startup.

**Files:**
- Modify: `src/orchestrator/startupRecovery.ts`
- Verify: `src/index.ts` calls `recoverStuckFetchingTokens` (no change needed if already called)

- [ ] **Step 1: Add `recoverPendingWork` to `startupRecovery.ts`**

  Replace the entire file with:
  ```ts
  import prisma from "../db/client.js";
  import { worker } from "./worker.js";
  import { createLogger } from "../utils/logger.js";

  const log = createLogger("orchestrator:startup-recovery");

  /**
   * Resets tokens stuck in FETCHING status back to PENDING.
   * Handles the case where the process was killed mid-fetch.
   */
  export async function recoverStuckFetchingTokens(): Promise<void> {
    const result = await prisma.token.updateMany({
      where: { metadataStatus: "FETCHING" },
      data: { metadataStatus: "PENDING" },
    });

    if (result.count > 0) {
      log.warn({ count: result.count }, "Reset stuck FETCHING tokens → PENDING on startup");
    }
  }

  /**
   * Re-enqueues work that was in the in-memory queue when the process last stopped.
   * Covers:
   *  - Tokens with PENDING metadataStatus (never fetched or failed quietly)
   *  - Collections with no name (COLLECTION_METADATA_FETCH never completed)
   */
  export async function recoverPendingWork(): Promise<void> {
    const [pendingTokens, unnamedCollections] = await Promise.all([
      prisma.token.findMany({
        where: { metadataStatus: "PENDING" },
        select: { chain: true, contractAddress: true, tokenId: true },
        take: 500,
      }),
      prisma.collection.findMany({
        where: { name: null },
        select: { chain: true, contractAddress: true },
        take: 200,
      }),
    ]);

    for (const t of pendingTokens) {
      worker.enqueue({ type: "METADATA_FETCH", chain: t.chain, contractAddress: t.contractAddress, tokenId: t.tokenId });
    }
    for (const c of unnamedCollections) {
      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: c.chain, contractAddress: c.contractAddress });
    }

    if (pendingTokens.length > 0 || unnamedCollections.length > 0) {
      log.info(
        { tokens: pendingTokens.length, collections: unnamedCollections.length },
        "Re-enqueued pending work on startup"
      );
    }
  }
  ```

- [ ] **Step 2: Call `recoverPendingWork` from startup**

  Check if `recoverPendingWork` is being called in `src/index.ts`:
  ```bash
  grep -n "recoverPending\|startupRecovery" /Users/kalamaha/dev/medialane-backend/src/index.ts
  ```

  If only `recoverStuckFetchingTokens` is called, add the new function. Open `src/index.ts` and find the startup block. After `recoverStuckFetchingTokens()`, add:
  ```ts
  import { recoverStuckFetchingTokens, recoverPendingWork } from "./orchestrator/startupRecovery.js";
  // ...
  await recoverStuckFetchingTokens();
  await recoverPendingWork();
  ```

- [ ] **Step 3: Start dev server to verify**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 5 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```
  Expected: `"status":"ok"`. Check logs for `"Re-enqueued pending work on startup"` if any pending records exist.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/orchestrator/startupRecovery.ts src/index.ts
  git commit -m "feat(backend): re-enqueue pending tokens and collections on startup — survive worker queue loss across restarts"
  ```

---

## Phase 4 — Cleanup

### Task 13: Replace `as any` with `Prisma.InputJsonValue` on JSON fields (M3)

> `typedData as any` and `calls as any` appear 17+ times in `intents.ts`. This narrows types to what Prisma actually accepts.

**Files:**
- Modify: `src/api/routes/intents.ts`

- [ ] **Step 1: Add Prisma import**

  At the top of `src/api/routes/intents.ts`, ensure the Prisma import exists:
  ```ts
  import { Prisma } from "@prisma/client";
  ```
  (If `prisma` is already imported from `../../db/client.js`, Prisma types can be imported from `@prisma/client` directly.)

- [ ] **Step 2: Replace all `as any` JSON casts**

  Run a search to find all occurrences:
  ```bash
  grep -n "as any" /Users/kalamaha/dev/medialane-backend/src/api/routes/intents.ts
  ```

  Replace every instance of `typedData as any` with `typedData as Prisma.InputJsonValue` and every `calls as any` with `calls as Prisma.InputJsonValue`. Use search-and-replace across the file — there are ~17 occurrences.

- [ ] **Step 3: Start dev server to verify**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/api/routes/intents.ts
  git commit -m "refactor(api): replace as-any JSON casts with Prisma.InputJsonValue in intents routes"
  ```

---

### Task 14: Rename `counterPrice` → `priceRaw` for consistency across the counter-offer stack (M4)

> The schema field is `counterPrice`, the intent builder param is `priceRaw`. This causes a silent rename in the route handler and makes the interface between HTTP and business logic harder to trace.

**Files:**
- Modify: `src/api/routes/intents.ts` (schema + mapping)

- [ ] **Step 1: Rename schema field**

  In `src/api/routes/intents.ts`, find `counterOfferSchema` (around line 145):
  ```ts
  // BEFORE
  const counterOfferSchema = z.object({
    sellerAddress:     z.string().min(1),
    originalOrderHash: z.string().min(1),
    durationSeconds:   z.number().int().min(3600).max(2592000),
    counterPrice:      z.string().regex(/^\d+$/, "counterPrice must be a non-negative integer string"),
    message:           z.string().max(500).optional(),
  });
  ```
  Change `counterPrice` to `priceRaw`:
  ```ts
  const counterOfferSchema = z.object({
    sellerAddress:     z.string().min(1),
    originalOrderHash: z.string().min(1),
    durationSeconds:   z.number().int().min(3600).max(2592000),
    priceRaw:          z.string().regex(/^\d+$/, "priceRaw must be a non-negative integer string"),
    message:           z.string().max(500).optional(),
  });
  ```

- [ ] **Step 2: Update the destructure in the handler**

  Find the destructure (around line 160):
  ```ts
  // BEFORE
  const { sellerAddress, originalOrderHash, durationSeconds, counterPrice, message } = parsed.data;
  ```
  Change to:
  ```ts
  const { sellerAddress, originalOrderHash, durationSeconds, priceRaw, message } = parsed.data;
  ```

  The `buildCounterOfferIntent` call (around line 188) already uses `priceRaw` as the param name, so the mapping at line 189:
  ```ts
  priceRaw: counterPrice,
  ```
  Becomes simply:
  ```ts
  priceRaw,
  ```

- [ ] **Step 3: Start dev server to verify**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/api/routes/intents.ts
  git commit -m "refactor(api): rename counterPrice → priceRaw in counter-offer schema — matches intent builder param name"
  ```

---

### Task 15: Fix `CANCELLATION_TYPES_1155` inner array pointer sharing (M5)

> Already covered by Task 9 (which spread both `SNIP12_TYPES_1155` and `CANCELLATION_TYPES_1155.OrderCancellation`). If Task 9 is complete, this task is done. Verify:

- [ ] **Step 1: Verify Task 9 included the CANCELLATION_TYPES_1155 spread**

  ```bash
  grep -A4 "CANCELLATION_TYPES_1155" /Users/kalamaha/dev/medialane-backend/src/orchestrator/intent.ts
  ```
  Expected output should show `[...CANCELLATION_TYPES.OrderCancellation]`, not `CANCELLATION_TYPES.OrderCancellation`.

  If not yet done (e.g., Task 9 was skipped), apply the same fix from Task 9 Step 1 and commit under the same message pattern.

---

### Task 16: Add warning log when `tokenStandard` is omitted on offer (M1)

> `offerSchema.tokenStandard` is optional, so an ERC1155 offer submitted without it silently routes to ERC721. Adding a server-side log makes this misrouting detectable in production.

**Files:**
- Modify: `src/api/routes/intents.ts` (offer handler)

- [ ] **Step 1: Add warning log before calling `buildMakeOfferIntent`**

  In the `POST /offer` handler (around line 122), before the `buildMakeOfferIntent` call:
  ```ts
  if (!parsed.data.tokenStandard) {
    log.warn(
      { nftContract: parsed.data.nftContract },
      "Offer intent created without tokenStandard — defaulting to ERC721 routing. Pass tokenStandard to avoid silent misrouting for ERC-1155 tokens."
    );
  }

  const { typedData, calls } = await buildMakeOfferIntent(parsed.data);
  ```

- [ ] **Step 2: Start dev server to verify**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend && ~/.bun/bin/bun run dev &
  sleep 3 && curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"'
  kill %1 2>/dev/null; true
  ```

- [ ] **Step 3: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-backend
  git add src/api/routes/intents.ts
  git commit -m "fix(api): warn when tokenStandard omitted on offer intent — surfaces ERC-1155 misrouting in logs"
  ```

---

### Task 17: Verify and align `item_type` encoding in SDK ERC1155 listing (M2)

> `createListing` (ERC721) manually calls `shortString.encodeShortString(item_type)` before passing to `contract.populate`. `createListing1155` passes `item_type` as a plain string. This task verifies which is correct against the ABI.

**Files:**
- Read: `src/abis.ts` (check `register_order` param types for Medialane1155ABI)
- Modify: `src/marketplace1155/orders.ts` if encoding is needed

- [ ] **Step 1: Check the ABI for `register_order` input field types**

  ```bash
  grep -A 60 '"register_order"' /Users/kalamaha/dev/medialane-sdk/src/abis.ts | head -70
  ```

  Look for the `item_type` field in the ABI inputs. If it has type `core::felt252`, the ABI encoder expects a numeric felt — meaning `shortString.encodeShortString("ERC1155")` is required. If it has type `core::integer::u8` or a custom Cairo enum, the field must be passed as the numeric enum value. If starknet.js accepts a shortstring directly for `felt252`, no manual encoding is needed.

- [ ] **Step 2: Act on findings**

  **If `item_type` is `core::felt252` and starknet.js ABI encoder does NOT auto-encode shortstrings:**

  In `src/marketplace1155/orders.ts`, update `createListing1155` to encode `item_type` fields before constructing `orderPayload`:
  ```ts
  const orderPayload = stringifyBigInts({
    parameters: {
      ...orderParams,
      offer: {
        ...orderParams.offer,
        item_type: shortString.encodeShortString(orderParams.offer.item_type),
      },
      consideration: {
        ...orderParams.consideration,
        item_type: shortString.encodeShortString(orderParams.consideration.item_type),
      },
    },
    signature: signatureArray,
  }) as Record<string, unknown>;
  ```
  Add `shortString` to the starknet import.

  Also apply the same change to `makeOffer1155` (added in Task 8).

  **If the ABI encoder handles shortstrings automatically (felt252 input + string value):** No change needed — document this in a comment above `orderPayload` construction.

- [ ] **Step 3: Typecheck and build**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun run build
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/marketplace1155/orders.ts
  git commit -m "fix(sdk): align item_type encoding in ERC-1155 register_order calldata"
  ```
  *(Skip this commit if no change was needed — note the finding in a comment instead.)*

---

### Task 18: Document `checkoutCart` sequential-nonce constraint (M7 + A1)

> The `checkoutCart` functions in both ERC721 and ERC1155 use a base nonce incremented per item. If a concurrent tx from the same account increments the on-chain nonce between `nonces()` fetch and `execute()`, all fulfillment signatures become invalid. This must be documented.

**Files:**
- Modify: `src/marketplace/orders.ts` (checkoutCart comment)
- Modify: `src/marketplace1155/orders.ts` (checkoutCart1155 — already has this comment from Task 11)

- [ ] **Step 1: Add constraint comment to `checkoutCart` in `src/marketplace/orders.ts`**

  Find the `checkoutCart` function (around line 445). Update the JSDoc:
  ```ts
  /**
   * Checkout a cart of multiple orders in a single atomic multicall.
   * Prompts wallet signatures sequentially (one per item), then executes
   * all approve + fulfill calls atomically.
   *
   * NONCE CONSTRAINT: This fetches a single base nonce and increments it per item
   * (baseNonce, baseNonce+1, ...). Any concurrent fulfill or cancel from the same
   * account between the nonce fetch and transaction execution will cause the entire
   * multicall to revert with a nonce mismatch. Do not call checkoutCart concurrently
   * with any other marketplace write operation from the same account.
   */
  ```

- [ ] **Step 2: Commit**

  ```bash
  cd /Users/kalamaha/dev/medialane-sdk
  git add src/marketplace/orders.ts
  git commit -m "docs(sdk): document sequential-nonce constraint on checkoutCart"
  ```

---

## Self-Review

**Spec coverage check:**

| Finding | Task | Covered? |
|---------|------|----------|
| C1 — ERC721 fulfillOrder missing approve | Task 1 | ✅ |
| C2 — ERC1155 start_time zero buffer | Task 2 | ✅ |
| C3 — start_time four-way inconsistency | Task 6 | ✅ (constant extracted) |
| C4 — SDK non-ASCII encodeByteArray | Task 5 | ✅ |
| C5 — Checkout ERC1155→ERC721 routing | Task 3 | ✅ |
| C6 — Counter-offer ERC1155 silent failure | Task 4 | ✅ |
| I1 — toSignatureArray/getChainId/resolveToken duplicated | Task 6 | ✅ |
| I2 — Separate provider caches | Task 6 | ✅ |
| I3 — SNIP12_TYPES_1155 live alias | Task 9 | ✅ |
| I4 — ItemType enum unused | Task 10 | ✅ |
| I5 — ERC1155CollectionService not mounted | Task 7 | ✅ |
| I6 — makeOffer missing from 1155 module | Task 8 | ✅ |
| I7 — No ERC1155 checkoutCart | Task 11 | ✅ |
| I8 — Worker queue lost on restart | Task 12 | ✅ |
| M1 — tokenStandard optional silently misroutes | Task 16 | ✅ (warn log) |
| M2 — item_type encoding inconsistency | Task 17 | ✅ |
| M3 — `as any` JSON casts | Task 13 | ✅ |
| M4 — counterPrice/priceRaw naming | Task 14 | ✅ |
| M5 — CANCELLATION_TYPES_1155 inner arrays | Task 15 | ✅ (via Task 9) |
| M6 — Startup recovery missing collections | Task 12 | ✅ |
| M7/A1 — checkoutCart nonce constraint undocumented | Task 18 | ✅ |
| A2 — TypedDataRevision.ACTIVE vs literal "1" | — | Not included (both are functionally identical; document in a follow-up if starknet.js changes the constant) |

**All 21 findings are covered across 18 tasks.**
