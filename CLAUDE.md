# CLAUDE.md

Guidance for Claude Code when working in this repository.
**Source of truth: actual source files, not RUNBOOK.md** (RUNBOOK was an early draft and is outdated in several places — see Critical Corrections below).

## Commands

```bash
~/.bun/bin/bun run dev          # watch mode
~/.bun/bin/bun run start        # production

~/.bun/bin/bun run db:migrate   # Prisma migrate dev (prompts for migration name) — ALWAYS run this when adding schema fields
~/.bun/bin/bun run db:generate  # regenerate Prisma client after schema changes
~/.bun/bin/bun run db:push      # push schema without a migration file
~/.bun/bin/bun run db:studio    # Prisma Studio at localhost:5555

~/.bun/bin/bun run backfill     # backfill historical on-chain data
~/.bun/bin/bun run reset-cursor # reset IndexerCursor to INDEXER_START_BLOCK

# Account-model scripts (added 2026-05-20)
~/.bun/bin/bun run verify-accounts        # invariants on the DB pointed to by DATABASE_URL
~/.bun/bin/bun run backfill-accounts      # legacy User/CreatorProfile → Account/Wallet/Identity/AccountProfile
~/.bun/bin/bun run prod:verify            # invariants against Railway prod (uses DATABASE_PUBLIC_URL)
~/.bun/bin/bun run prod:migrate-status    # `prisma migrate status` against Railway prod
```

Always use `~/.bun/bin/bun` — bun is not in PATH by default on this machine.
No linting or test runner configured. Verify with curl against localhost:3000.

**Hitting Railway prod from local** requires the public proxy URL — the in-cluster `postgres.railway.internal` won't resolve. The `prod:*` aliases above wrap `railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" …'`; prefer them over open-coding the incantation. Verify output now includes a `connection` field so the DB the numbers came from is unambiguous.

---

## Architecture

Three concurrent loops on startup (`src/index.ts`):

```
Starknet RPC → Mirror (Indexer) → PostgreSQL ← Orchestrator
                                       ↑
                                 Hono REST API ← dApps / SDK
```

### Mirror (`src/mirror/`)
- Polls marketplace contract every `INDEXER_POLL_INTERVAL_MS` (default 6s)
- Batches of `INDEXER_BLOCK_BATCH_SIZE` (default 500 blocks)
- Each tick: `poller.ts` fetches events → `parser.ts` parses felts → atomic DB write + cursor advance → enqueues `METADATA_FETCH` + `STATS_UPDATE` jobs
- `IndexerCursor` singleton tracks `lastBlock`. `reset-cursor` moves it back (does not delete data)

### Orchestrator (`src/orchestrator/`)

Two distinct queue mechanisms, intentionally — keep them straight when editing:

**In-memory worker** (`worker.ts`, `InMemoryWorker`). Enqueued directly by the indexer (`worker.enqueue(...)`). State lives in the process; restart drops the queue. Safe because every job type sets a durable DB flag the indexer can re-derive from:

| Job | What it does | Durability on restart |
|---|---|---|
| `METADATA_FETCH` | Calls `token_uri` on ERC-721/`uri` on ERC-1155, resolves URI via `src/discovery/` (Pinata → Cloudflare → ipfs.io), stores on `Token` | `Token.metadataStatus = PENDING` persists; `startupRecovery.recoverPendingWork()` re-enqueues on boot; `metadataRetryLoop` re-queues `FAILED` on a schedule |
| `STATS_UPDATE` | Recomputes floor price, total volume, holder count, total supply for a `Collection` | Idempotent; next indexer tick that touches the collection re-enqueues it |
| `COLLECTION_METADATA_FETCH` | Fetches collection metadata: calls `name()`/`symbol()`/`base_uri()` on-chain; recovers `image`/`description`/`owner` from `CREATE_COLLECTION` intent `typedData` (matched by name); falls back to on-chain `owner()` call. Uses **upsert** — can create new collection records from scratch | `Collection.metadataStatus = PENDING` persists; recovered the same way |

In-process retry: max 3 attempts, linear backoff (`RETRY_BASE_MS * attempts`). Cross-restart retry: the recovery layer above.

**Persistent loops** (`orchestrator/index.ts` starts these as long-running tasks):

| Loop | Backing table | Behavior |
|---|---|---|
| `startWebhookDeliveryLoop` | `WebhookDelivery` | Polls every 10s, max 5 attempts, sets `isTerminal=true` when exhausted. **Durable across restarts.** |
| `startMetadataRetryLoop` | `Token` | Periodically scans for `metadataStatus=FAILED` and re-enqueues into the in-memory worker |
| `startReaper` | `TransactionIntent` | Sweeps expired `PENDING` intents → `EXPIRED` |

> **METADATA_PIN** is referenced in older docs as a job type — not implemented (Pinata free plan doesn't support `pin_by_cid`).

> **Historical note:** earlier README/RUNBOOK drafts described a unified `Job` table polled every 2s for all job types with optimistic-lock claiming. That model was never fully built — only webhook delivery uses `Job`-style persistence. Don't trust older docs; trust the source files cited above.

### HTTP API (`src/api/`)
- Hono on `PORT` (default 3000)
- `/health` — public, no auth
- `/v1/*` — tenant API key required (see Auth)
- `/admin/*` — `API_SECRET_KEY` header required (via `authMiddleware`)
- `/v1/portal/*` — tenant key required; **excluded from monthly quota count**
- `/v1/intents/*` — also rate-limited to 20 req/min per IP (additional middleware)

---

## Auth

Two accepted formats (both checked by `apiKeyAuth` middleware):
```
x-api-key: ml_live_...
Authorization: Bearer ml_live_...
```

**`x-api-key` takes priority over `Authorization: Bearer`**. Some routes (e.g. `PATCH /v1/creators/:wallet/profile`) require both a tenant key (`apiKeyAuth`) and a Clerk JWT (`clerkAuth`). The SDK sends both simultaneously: `x-api-key: ml_live_...` + `Authorization: Bearer <clerkToken>`. Reading `Authorization` first would cause the Clerk JWT to be treated as the API key and fail. Do not change this priority.

Lookup: `hashApiKey(raw)` → DB lookup on `ApiKey.keyHash`. Rejected if key `status !== "ACTIVE"` or tenant `status !== "ACTIVE"` (SUSPENDED tenants → 401 even with valid key). `lastUsedAt` updated fire-and-forget (non-blocking).

PREMIUM-only endpoints use `requirePlan("PREMIUM")` middleware → 403 `{ error: "Upgrade required", requiredPlan: "PREMIUM" }` for FREE tenants.

---

## Rate Limiting (`src/api/middleware/rateLimit.ts`)

**Keyed by API key ID** (not IP).

| Plan | Limit | Window | How tracked |
|---|---|---|---|
| FREE | 50 requests | per calendar month | Atomic Postgres `UPDATE … WHERE count < limit RETURNING` on `ApiKey.monthlyRequestCount`. DB-backed, multi-instance safe. |
| PREMIUM | 3,000 requests | per minute | `RedisRateLimitStore` when `REDIS_URL` is set (multi-instance safe); otherwise falls back to `InMemoryRateLimitStore` (per-process, single-replica only). Store selected in `src/api/middleware/rateLimit.ts:56`. |

> **Multi-replica deploys MUST set `REDIS_URL`.** Without it the PREMIUM counter is per-process — N replicas means N× the documented limit and FREE-vs-PREMIUM headers drift. The FREE path is already multi-instance safe via the DB.

Response headers on every `/v1/*` response:
- `X-RateLimit-Limit` — 50 (FREE) or 3000 (PREMIUM)
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset` — Unix timestamp
- `Retry-After` — added on 429

> RUNBOOK.md incorrectly stated FREE = 60 req/min. The actual code is 50 req/month from DB.

---

## API Route Inventory (verified from source)

### Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | DB + indexer lag status |

### Tenant (`x-api-key` required)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/orders` | `status`, `collection`, `currency`, `sort` (price_asc/price_desc/recent), `offerer`, `page`, `limit` (max 100) |
| GET | `/v1/orders/:orderHash` | |
| GET | `/v1/orders/token/:contract/:tokenId` | Active orders only |
| GET | `/v1/orders/user/:address` | `page`, `limit` |
| GET | `/v1/collections` | `page` (max clamped), `limit` (max 100), `?owner=address`, `?isKnown=true\|false`, `?sort=recent\|supply\|floor\|volume\|name` (default: `recent` = `createdAt DESC`). `floor`/`volume` use `$queryRaw` with `::numeric NULLS LAST`. |
| GET | `/v1/collections/:contract` | |
| GET | `/v1/collections/:contract/tokens` | `page`, `limit`. Each token carries `balances` (per-holder `owner`+`amount`) so clients can determine ownership from a list response (added 2026-05-20). |
| GET | `/v1/tokens/owned/:address` | `page`, `limit` |
| GET | `/v1/tokens/:contract/:tokenId` | `?wait=true` blocks 3s for JIT metadata |
| GET | `/v1/tokens/:contract/:tokenId/history` | Mixed transfers + orders, sorted by timestamp |
| GET | `/v1/tokens/:contract/:tokenId/comments` | On-chain comments for token. `page`, `limit`. Excludes `isHidden=true` comments. Returns `{ data: ApiComment[], meta }` |
| GET | `/v1/activities` | `?type=transfer\|sale\|listing\|offer`, `page`, `limit` |
| GET | `/v1/activities/:address` | `page`, `limit` |
| GET | `/v1/search` | `?q=` (min 2 chars), `limit` (max 50). Returns `{ data: { tokens, collections }, query }` |
| GET | `/v1/pop/eligibility/:collection/:wallet` | POP claim eligibility. Returns `{ isEligible, hasClaimed, tokenId }` |
| GET | `/v1/pop/eligibility/:collection` | Batch eligibility. `?wallets=0x1,0x2` (max 100) |
| GET | `/v1/drop/mint-status/:collection/:wallet` | Drop mint status. Returns `{ mintedByWallet, totalMinted }` |
| POST | `/v1/drop/conditions` | **Clerk JWT required** (not just API key). Body: `{ collectionAddress, maxSupply, price, paymentToken, startTime, endTime, maxPerWallet }`. Ownership check: caller must match `collection.owner` or `collection.claimedBy`. |
| GET | `/v1/drop/:contract/info` | Collection metadata merged with claim conditions. Public. |
| POST | `/v1/intents/listing` | Rate limited 20/min per IP |
| POST | `/v1/intents/offer` | Rate limited 20/min per IP |
| POST | `/v1/intents/fulfill` | Rate limited 20/min per IP |
| POST | `/v1/intents/cancel` | Rate limited 20/min per IP |
| POST | `/v1/intents/mint` | `{ owner, collectionId, recipient, tokenUri, collectionContract? }` — SIGNED immediately, no SNIP-12. `owner` must be the collection owner; validated on-chain via `is_collection_owner` before intent is created |
| POST | `/v1/intents/create-collection` | `{ owner, name, symbol, baseUri, image?: string, collectionContract? }` — SIGNED immediately, no SNIP-12. `owner` + `image` stored in `typedData` JSON, recovered by `COLLECTION_METADATA_FETCH` when collection is indexed. On-chain owner = wallet that executes the returned `calls`. |
| GET | `/v1/intents/:id` | Auto-expires PENDING → EXPIRED on read |
| PATCH | `/v1/intents/:id/signature` | `{ signature: string[] }` → status SIGNED, calls populated. Returns 400 for MINT/CREATE_COLLECTION |
| GET | `/v1/metadata/signed-url` | Pinata presigned URL (30s TTL) |
| POST | `/v1/metadata/upload` | JSON body → Pinata → `{ cid, url: "ipfs://..." }` |
| POST | `/v1/metadata/upload-file` | Multipart `file` field → Pinata → `{ cid, url }` |
| GET | `/v1/metadata/resolve` | `?uri=` — resolves ipfs://, data:, https:// |
| GET | `/v1/collections/:contract/gated-content` | Clerk JWT + tenant API key required. Checks token ownership; returns `{ title, url, type }` to verified holders only; 403 for non-holders. `gatedContentUrl` is **never** exposed in public profile GET. |
| GET | `/v1/collections/by-slug/:slug` | Resolve a vanity slug to a full collection. Returns 404 if slug not claimed/approved. |
| GET | `/v1/collection-slug-claims/check/:slug` | Public availability check. Returns `{ available: boolean; reason?: string }`. No auth required. Mounted **before** global apiKeyAuth. |
| POST | `/v1/collection-slug-claims` | Submit a slug claim. Clerk JWT required; caller must be collection `owner` or `claimedBy`. Body: `{ contractAddress, slug, notifyEmail? }`. |
| GET | `/v1/collection-slug-claims/me` | Returns all slug claims submitted by the authenticated wallet. Clerk JWT required. |
| POST | `/v1/users/register` | Frictionless account creation. Body: `{ walletAddress, walletType?, appSource?, chain? }`. Idempotent — returns existing Account if known. Tenant key only. |
| POST | `/v1/users/me` | Upsert the JWT caller's Account (lazy onboarding for first-touch flows). identityAuth (Clerk JWT or SIWS). |
| GET | `/v1/users/me` | Returns `{ walletAddress, accountId, publicId }` for JWT caller. 404 if unknown. identityAuth. |
| GET | `/v1/users/count` | Account count with optional filters `?chain&appSource&walletType&since`. Used for grant reporting. Tenant key only. |
| GET | `/v1/portal/me` | `{ id, name, email, plan, status }` |
| GET | `/v1/portal/keys` | List keys (prefix only, no plaintext) |
| POST | `/v1/portal/keys` | `{ label? }` — max 5 active; returns plaintext ONCE |
| DELETE | `/v1/portal/keys/:id` | → status REVOKED |
| GET | `/v1/portal/usage/recent` | Last 10 UsageLog rows |
| GET | `/v1/portal/usage` | 30 days grouped by day `{ day: "YYYY-MM-DD", requests }[]` |
| GET | `/v1/rewards/:address` | Score + level + progress + badges + XP breakdown for one address |
| GET | `/v1/rewards` | Paginated leaderboard. `page`, `limit` (max 100) |
| GET | `/v1/rewards/:address/events` | Point event history for an address. `page`, `limit` |
| GET | `/v1/portal/webhooks` | **PREMIUM only** |
| POST | `/v1/portal/webhooks` | **PREMIUM only**. `{ url, events[], label? }`. Returns secret ONCE (`whsec_...`) |
| DELETE | `/v1/portal/webhooks/:id` | **PREMIUM only** → status DISABLED |

### Admin (`API_SECRET_KEY` required)

> **Structure (2026-05-18):** admin routes live in `src/api/routes/admin/` — `index.ts` (Hono instance, shared IP rate-limit, the two global `admin.use("*")` middlewares, registrar calls, default export) + `_shared.ts` + domain files `tenants.ts`, `collections.ts` (collections/tokens/indexer), `claims.ts`, `marketplace-ops.ts`, `moderation.ts`. Each domain file exports `register<Domain>Routes(admin)` and mutates the same instance (registrar pattern — add new admin routes to the matching domain file, never recreate the Hono instance). `adminRewards` is separate in `routes/rewards.ts`.

| Method | Path | Notes |
|---|---|---|
| POST | `/admin/tenants` | Create tenant + initial key. Returns `plaintext` ONCE |
| GET | `/admin/tenants` | List all tenants |
| PATCH | `/admin/tenants/:id` | Update `plan` and/or `status` |
| POST | `/admin/tenants/:id/keys` | Create additional key for tenant |
| DELETE | `/admin/keys/:keyId` | Revoke any key (soft delete) |
| GET | `/admin/usage` | `?tenantId=` (optional), `?days=` (max 90, default 30) |
| POST | `/admin/tokens/:contract/:tokenId/refresh` | Force-sync token metadata (bypasses queue). Returns `{ metadataStatus, tokenUri, name }` |
| POST | `/admin/collections` | Register new collection address + enqueue metadata fetch. Body: `{ contractAddress, startBlock?, chain? }` |
| PATCH | `/admin/collections/:contract` | Update `isKnown`, `owner`, or any metadata field |
| POST | `/admin/collections/backfill-metadata` | Enqueue `COLLECTION_METADATA_FETCH` for all PENDING/FAILED/unnamed/ownerless collections |
| POST | `/admin/collections/backfill-registry` | Scan ALL `CollectionCreated` events on-chain + upsert every missing collection. Returns `{ inserted, skipped }` |
| POST | `/admin/collections/:contract/refresh` | Force-trigger `COLLECTION_METADATA_FETCH` for one collection (uses upsert, can create from scratch) |
| GET | `/admin/collection-slug-claims` | List collection slug claims. `?status=PENDING\|APPROVED\|REJECTED`, `page`, `limit` |
| PATCH | `/admin/collection-slug-claims/:id` | Approve or reject a slug claim. Body: `{ status: "APPROVED"\|"REJECTED", adminNotes? }`. On approve: writes slug to `CollectionProfile` (upsert) and rejects competing pending claims. |
| GET | `/admin/comments` | List comments. `?hidden=true\|false`, `?author=address`, `?contract=address`, `page`, `limit` |
| PATCH | `/admin/comments/:id/hide` | Set `isHidden = true` on a comment |
| PATCH | `/admin/comments/:id/show` | Set `isHidden = false` on a comment |
| POST | `/admin/pop/allowlist` | Bulk add wallets to `PopAllowlist`. Body: `{ collectionAddress, addresses[] }`. Works for both POP and COLLECTION_DROP collections. |
| DELETE | `/admin/pop/allowlist` | Bulk remove wallets (sets `allowed=false`). Body: `{ collectionAddress, addresses[] }` |
| GET | `/admin/rewards/config` | Read current DAO reward config (actions, multipliers, levels) |
| PATCH | `/admin/rewards/levels/:level` | Update level name, XP threshold, badge color, description |
| PATCH | `/admin/rewards/actions/:type` | Update action XP weight, daily cap, min value, enabled flag |
| PATCH | `/admin/rewards/multipliers/:id` | Toggle or adjust a multiplier factor |
| GET | `/admin/rewards/badges` | List all badge definitions |
| PATCH | `/admin/rewards/badges/:key` | Update badge name, description, icon, color, enabled |
| POST | `/admin/rewards/badges/:address` | Manually award a badge to an address. Body: `{ badgeKey, txHash? }` |
| POST | `/admin/rewards/compute` | Trigger retroactive XP + badge computation. `?dry_run=true` to preview. Responds when complete with `{ ok, elapsedMs, output }` |

---

## Key Conventions

- **Runtime**: Bun only. `~/.bun/bin/bun`, never `node`/`npm`/`npx`.
- **Path alias**: `@/*` → `src/*` (`tsconfig.json`).
- **Imports**: `.js` extension in all import paths (ESM bundler resolution).
- **BigInt**: Starknet amounts + block numbers as `BigInt` in TS; stored as `String` in DB.
- **Address normalization**: Always `normalizeAddress()` (`src/utils/starknet.ts`) before DB writes AND before DB queries. 64-char lowercase 0x-padded hex. Applied in all route handlers: `GET /v1/tokens/owned/:address`, `GET /v1/orders/user/:address`, `GET /v1/activities/:address`, `GET /v1/collections?owner=`, `GET /v1/collections/:contract`, `GET /v1/collections/:contract/tokens`, all `/admin/collections/*` routes, and `offerer` filter in `GET /v1/orders`. **Never use `.toLowerCase()` alone** — it does not pad short addresses and causes "not found" mismatches.
- **Logging**: `createLogger(name)` from `src/utils/logger.ts` (pino). Never `console.log` in long-running code (api / mirror / orchestrator / utils).
  - **Exception:** one-shot CLI scripts under `src/scripts/` and `scripts/` (`seed-rewards`, `compute-rewards`, `verify-account-model`, `backfill*`, etc.) intentionally use `console.log` — they run with a TTY attached, the output IS the UX, and pino's JSON formatting would obscure it. Don't "consistency-ify" these to pino.
- **Error shape**: `{ error: string }` — not `{ message }`.
- **Success shape**: `{ data: T }` for single items; `{ data: T[], meta: { page, limit, total } }` for lists. Exception: search returns `{ data: { tokens, collections }, query }`.

---

## Critical Design Notes

### RPC resilience (added 2026-06-03)

Alchemy's Starknet endpoint intermittently 503s (`-32001 "Unable to complete
request"`). Two complementary layers, both falling back to public endpoints
from `@medialane/sdk`'s `PUBLIC_RPC_FALLBACKS` (lava.build, …) — single source:

- **Circuit-breaker provider** (`src/utils/starknet.ts`): `createProvider()` /
  `callRpc()` — used by indexer/orchestrator hot paths via the starknet.js
  `RpcProvider`. `getFallback()` defaults to `PUBLIC_RPC_FALLBACKS[0]` when
  `STARKNET_RPC_FALLBACK_URL` is unset, so the breaker always has a target.
- **`postRpc` primitive** (`src/utils/rpcFetch.ts`): `rpcEndpoints()` + `postRpc(body)`
  — one endpoint list + one rotation loop for the **raw-fetch** JSON-RPC paths.
  `txVerifier` (receipts, `checkOnChainOrderCancelled`), `orderCreated` (1155
  order details), and `intent` (counter + royalty reads) all go through it.
  Rotates until a `result` appears, throws if none; callers keep their own
  decoding/validation. **Do not re-add per-file `for (const url of urls)` loops** —
  add new raw RPC calls via `postRpc`.

Full incident + cross-app architecture: `medialane-core/docs/specs/2026-06-03-rpc-resilience-failover.md`.

### Platform fee + collection-token ownership (added 2026-05-20)

**Platform fee in fulfill intents.** `buildFulfillOrderIntent` (`src/orchestrator/intent.ts`),
in the **listing branch only** (buyer fulfills a listing), appends an ERC-20
`transfer` to the creators-fund address after the `approve` and before
`fulfill_order`. The fee is computed by `buildFeeCall` from `@medialane/sdk`
(single source of truth); config via `src/config/fee.ts` (`FEE_ENABLED`,
`FEE_FUND_ADDRESS`, `FEE_MARKETPLACE_BPS`/`FEE_LAUNCHPAD_BPS`, default 1%).
The accept-offer (`isOffer`) branch is intentionally **not** fee'd — the
fulfiller there is the seller, not the payer. No fee logic on-chain — platform
layer only (`00 §12`).

**Collection-token balances.** `GET /v1/collections/:contract/tokens` now batch-
queries `TokenBalance` and includes per-token `balances` in the list response.
Previously `balances` was `null` on list responses, so clients (e.g. the io
collection page) couldn't tell which tokens the viewer owns. One indexed query
per page.

### Account model (shipped 2026-05-20)

The legacy `User` table has been replaced by a four-table model (PRs medialane-backend#17 and #18). Plan: `medialane-core/docs/plans/2026-05-18-account-model-redesign.md`. Architecture: `medialane-core/docs/architecture/01-core-model.md §II`, `07-identity-model.md`.

**Tables:**
- `Account` — the logical actor (`publicId`, roles[], `createdAt`). One per human/agent/org/collector. Reputation, badges, scores attach here.
- `Wallet` — `(chain, address)`, normalized. Unique. Has `walletType`, `isPrimary`. v1: one Wallet per Account; year-2: many.
- `Identity` — auth-provider record (`provider`, `appSource`, optional `externalId`). One Account may have several (e.g. CLERK + WALLET).
- `AccountProfile` — off-chain enrichment (`username`, `displayName`, `bio`, social URLs, images). Keyed by `accountId` (unique) so an orphan Profile is structurally impossible.

**Helpers (`src/utils/account.ts`):**
- `resolveAccountIdFromWallet(chain, address)` — read; returns `accountId | null`.
- `ensureAccountForWallet({chain, address, walletType, appSource, identityProvider?})` — idempotent upsert; returns `{ accountId, walletId }`. Every code path that creates a Profile, awards a badge, or links a reward MUST resolve the Account through this helper first, never via raw `prisma.account.create`.

**Invariants enforced in code (verified by `bun run verify-accounts`):**
- `orphan_wallets_no_account = 0` — every Wallet has an Account (Prisma FK).
- `wallets_with_multiple_accounts = 0` — `(chain, address)` is unique on Wallet.
- `AccountProfile.accountId` is the unique key, so every Profile has an Account by definition.

**Rewards link (commit 7d9eb62):** `UserScore`, `UserBadge`, `PointEvent` now carry an optional `accountId`. Backfill populated 19/508 scores, 35/544 badges (the remaining ~489 are activity-only addresses that never onboarded — Tier-2, deferred). `compute-rewards.ts` writes the linkage when the wallet maps to a known Account.

**Production state (2026-05-20 after backfill):** 61 Accounts, 61 Wallets, 59 Identities, 61 AccountProfiles, 0 orphan wallets. Run `bun run prod:verify` any time to refresh these numbers; output includes a `connection` field naming the DB.

**Deferred (not blocked):**
- Tier-2 backfill: provision Accounts for the ~449 activity-only addresses (`UserScore` rows with no matching wallet).
- Cross-chain `WalletAttestation` (year-2 per `07 §IV`). Schema is shaped to accept it without migration.
- Drop legacy `User` and `CreatorProfile` (Phase 2 of the plan). The new code no longer reads them; deletion is a future cleanup.

### Collection invariants (added 2026-05-22 / 2026-05-23)

Structural guarantees that the source-of-null bug class (silent `service: null` writes from claims / admin / orchestrator paths that mis-classified 108 production collections) cannot recur:

- **`Collection.service` is `NOT NULL`** (migration `20260522180000_collection_service_not_null`). Postgres rejects any null write — the DB is the wall, not a convention.
- **`TokenStandard.UNKNOWN` removed** (migration `20260523000000_drop_tokenstandard_unknown`). Standard is either `ERC721` or `ERC1155`; no phantom-state defensive code allowed.
- **Single creation path** — `utils/collection.ts` exports two helpers (`upsertCollectionFromFactory` and `ensureCollectionFromActivity`). All indexer factory handlers + the orderCreated + transfer handlers go through one of them. Other paths (claims, metadata fetch) are now update-only and refuse to invent rows.
- **`service` values typed against `ServiceId` from `@medialane/sdk`** (≥0.20.0). Typos like `pop_protocol` fail at compile time. Runtime `assertRegisteredService()` in the helper catches dynamic values from request bodies.

#### Service IDs (canonical, registered in SDK `services/registry.ts`)

| `service` value | Meaning |
|---|---|
| `mip-erc721` | Per-creator ERC-721 deployed via MIP-Collections-ERC721 registry |
| `mip-erc1155` | Per-creator ERC-1155 deployed via IP-Programmable-ERC1155 factory |
| `ip-erc721` | Shared genesis ERC-721 contract |
| `pop-protocol` | Soulbound proof-of-presence (POP factory) |
| `drop-collection` | Timed-window collection drop (Drop factory) |
| `external-erc721` | Any ERC-721 contract not deployed via a Medialane service |
| `external-erc1155` | Any ERC-1155 contract not deployed via a Medialane service |
| `medialane-marketplace-erc721` | Marketplace venue (orders only) |
| `medialane-marketplace-erc1155` | Marketplace venue (orders only) |

Legacy collections from prior contract redeployments are tagged `external-*` (the platform can no longer mint to them via the current factories, so they're operationally equivalent to true externals). When a future contract version ships, the corresponding existing rows get re-tagged `external-*` in the redeploy SQL.

### Rewards & Ranking System (added 2026-05-12)

50-level DAO-managed XP system. All weights are in DB tables — adjustable via admin API without code deploys.

**Models**: `RewardLevel` (50 levels), `RewardAction` (per-action XP weights + daily caps), `RewardMultiplier` (global multipliers), `BadgeDefinition` (badge catalogue), `UserScore` (computed per address), `UserBadge` (awarded badges), `PointEvent` (audit log).

**Seeding**: `src/scripts/seed-rewards.ts` — idempotent upsert of 50 levels, 15 actions, 3 multipliers, 14 badges. Runs automatically on every Railway deploy.

**Computation**: `src/scripts/compute-rewards.ts` — retroactive XP engine. Reads Order, OrderFill, Transfer, Comment, Collection, RemixOffer, CreatorProfile; enforces per-action daily caps; applies `beta_tester` (1.5×) and `first_100` (2.0×) multipliers; truncates + rebuilds UserScore / PointEvent / UserBadge. Triggered via `POST /admin/rewards/compute` or `bun run compute-rewards`. Safe to re-run.

**Anti-gaming**: Action-based scoring (not volume-proportional) — no incentive to wash trade.

**Scripts**: `bun run seed-rewards`, `bun run compute-rewards [--dry-run] [--no-badges]`

### Collection Slug Claims (added 2026-05-06)

`CollectionProfile` has a new `slug String? @unique` field. New `CollectionSlugClaim` model mirrors `UsernameClaim` but keyed on `contractAddress` rather than wallet.

- `GET /v1/collection-slug-claims/check/:slug` — public; validates format + checks for taken profile slug or pending/approved claim.
- `POST /v1/collection-slug-claims` — Clerk JWT required; verifies caller is `collection.owner` or `collection.claimedBy`. One pending claim per collection at a time.
- `PATCH /admin/collection-slug-claims/:id` — on APPROVED: upserts `CollectionProfile.slug`; rejects all other pending claims for same slug or same contract.
- `GET /v1/collections/by-slug/:slug` — looks up `CollectionProfile` by slug, joins to `Collection`, returns full serialized collection.
- Slug rules: 3–20 chars, `/^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$|^[a-z0-9]{3}$/`, same RESERVED set as username claims.
- Routes mounted **before** global `apiKeyAuth` in `server.ts` (same pattern as `/v1/username-claims`).

### Token-Gated Content (added 2026-03-31)

`CollectionProfile` Prisma model has 4 new fields: `gatedContentTitle String?`, `gatedContentUrl String?`, `gatedContentType String?`, `hasGatedContent Boolean @default(false)`.

- `GET /v1/collections/:contract/profile` — public; returns `hasGatedContent` + `gatedContentTitle` only. **Never returns `gatedContentUrl`.**
- `PATCH /v1/collections/:contract/profile` — accepts `gatedContentTitle`, `gatedContentUrl`, `gatedContentType` (enum values: `VIDEO | STREAM | AUDIO | DOCUMENT | LINK`).
- `GET /v1/collections/:contract/gated-content` — Clerk JWT + tenant API key; **authorization comes from on-chain `balance_of` (ERC-721) or `balance_of_batch` over indexed token IDs (ERC-1155)** — NOT from `TokenBalance` cache. This was changed 2026-05-27 (PR #45) to satisfy `07-identity §V` (the indexer is a cache, not an authority — a missed Transfer would lock out a real holder). RPC failure returns **503**, never falls back to the DB. Returns `{ title, url, type }` to holders; 403 for non-holders; 404 if collection not indexed yet.

### SIWS — counterfactual smart-wallet handling (added 2026-05-27)

`POST /v1/auth/siws/verify` distinguishes "wallet contract not deployed" from generic invalid-signature. Starknet smart wallets (Ready / Argent, Braavos) are counterfactual until the first tx — they can receive tokens at a computed address but `is_valid_signature` has no contract to call. The verify route catches the resulting "Contract not found" RPC error and returns **400** with `{ error: "account_not_deployed", message: "Check if your wallet is deployed on Starknet." }`. Other RPC failures keep the existing 401 + `log.error` shape. Pair with medialane-dapp PR #29 which surfaces the friendly message in the upload toast.

> **Diagnostic logging in routes that wrap RPC calls is mandatory** — silent `catch {}` blocks make incidents like this one untraceable. The SIWS verify route's earlier `catch {}` (pre-PR #47) hid 4 days of failures before we spotted it. New routes that wrap `verifyMessageInStarknet` / `callContract` / similar must log the real error in the catch path.

### `/v1/users/me` accepts optional `chain` (added 2026-05-27)

`meBodySchema` now accepts `{ walletType?, appSource?, chain? }`. v1 only allows `STARKNET` — `identityAuth` only issues tokens for Starknet wallets (Clerk JWT → ChipiPay Starknet address; SIWS → Starknet signature), so accepting a non-`STARKNET` chain would mis-register a Starknet-derived address. The route returns 400 for any other value. Guard relaxes naturally when SIWE / SIWB land. SDK 0.25.0 + medialane-io call sites pass `chain: "STARKNET"` explicitly to lock the year-2-correct shape into v1.

### CollectionCreated event indexing (added 2026-03-08)
The mirror now polls the collection registry for `CollectionCreated` events on every tick (alongside marketplace and Transfer events). When detected:
1. `resolveCollectionCreated()` in `src/mirror/handlers/collectionCreated.ts` calls `get_collection(collection_id)` on the registry to get the `ip_nft` (ERC-721 contract address)
2. Collection is upserted into DB with owner, name, symbol, baseUri, startBlock, and **collectionId** (the on-chain decimal string registry ID — e.g. `"1"`)
3. `COLLECTION_METADATA_FETCH` job is enqueued for full enrichment

**`collectionId` field** (added 2026-03-09): stored on `Collection` as `String?`. Required by `POST /v1/intents/mint` to encode the Cairo uint256 collection ID. Collections indexed before this migration will have `collectionId = null` until re-indexed via `POST /admin/collections/backfill-registry`.

**Event layout — audited contract (2026-05-14):** `collection_id` is `#[key]` on the new IPCollection, so it's emitted in `event.keys[1..2]` (u256 low+high split), not in `event.data`. `owner` is `event.data[0]`. The rest of `event.data` is `[...name_bytearray, ...symbol_bytearray, ...base_uri_bytearray]`. **ip_nft is NOT in the event** — must call `get_collection()` on the registry.

**Decoder helper:** Always decode this event via `decodeCollectionCreatedEvent({ keys, data })` exported from `src/mirror/handlers/collectionCreated.ts`. The function is the single source of truth for the layout — three call sites use it (`mirror/parser.ts`, `routes/collections.ts` sync-tx, `routes/admin/collections.ts` backfill-registry). Never open-code the decode again; when the event shape changes, update the helper and every site benefits.

**If the indexer cursor already passed the collection creation blocks**: run `POST /admin/collections/backfill-registry` once — it scans all historical events and upserts everything in one call.

### Event parsing
- `OrderCreated` keys = `[selector, order_hash, offerer]` — no order params in event
- Must call `get_order_details(order_hash)` on-chain to get full `OrderParameters`
- ERC-721 Transfer tokenId = u256 split: keys[3] = low, keys[4] = high

### Listing vs bid
- Listing: `offer.item_type = ERC721/ERC1155`, `consideration.item_type = ERC20` → nftContract = offer.token
- Bid: `offer.item_type = ERC20`, `consideration.item_type = ERC721/ERC1155` → nftContract = consideration.token (fixed 2026-03-01)
- **Cancel/fulfill tokenStandard derivation**: for bid orders, `offer.itemType` is `"ERC20"` — the NFT standard lives in `consideration.itemType`. The frontend (`use-order-actions.ts`) was sending `"ERC20"` as `tokenStandard` for cancel calls on bid orders; fixed 2026-04-30.

### Price sorting
`priceRaw` is a String DB column. Uses `$queryRaw` with `::numeric NULLS LAST`. Do not change to ORM sort.

### $queryRaw with PostgreSQL enum columns (CRITICAL — fixed 2026-03-16)
Prisma `$queryRaw` tagged templates send interpolated values as typed `text` parameters. PostgreSQL **cannot implicitly cast `text` to a named enum type** — this causes:
```
ERROR: operator does not exist: "OrderStatus" = text  (code 42883)
```
Always append the explicit cast after the interpolated param:
```ts
// ❌ wrong — causes 500
conditions.push(Prisma.sql`status = ${status}`);

// ✅ correct
conditions.push(Prisma.sql`status = ${status}::"OrderStatus"`);
```
Apply this pattern to **every** `$queryRaw` that compares against an enum column. All three occurrences in `src/api/routes/orders.ts` use the cast.

### Intents
- **`requiresSignature` on every create-intent response (added 2026-05-31)**: each `POST /v1/intents/*` build route returns `requiresSignature: boolean` in `data` — `true` for listing/offer/cancel/counter (created `PENDING`, SNIP-12), `false` for fulfill/mint/create-collection/checkout (created `SIGNED`, prebuilt calls). Lets clients (SDK `ApiIntentCreated` union 0.27.0; io `runIntent`) stop inferring signed-vs-unsigned from `typedData` presence. Additive + backward-compatible.
- **Fulfilment is unsigned (0.26.0 redesigned venues)**: `buildFulfillOrderIntent` returns fully-populated `calls` (approve + `fulfill_order(orderHash[, qty])` + fee on the listing branch), no `typedData`; the intent is created `SIGNED`. The caller IS the fulfiller.
- TTL: 24 hours. `PENDING → SIGNED` (on signature submit) or `PENDING → EXPIRED` (on GET read after TTL)
- `PATCH /:id/signature` → `buildPopulatedCalls()` injects signature into stored calldata, returns updated intent
- **MINT / CREATE_COLLECTION**: no SNIP-12 signing required — created directly as `SIGNED` with fully-populated calldata. `PATCH /:id/signature` returns 400 for these types.
- **MINT**: requires `owner` field — validated on-chain via `is_collection_owner(collection_id, owner)` before intent created. `owner` wallet must execute the returned `calls` (contract checks `get_caller_address() == collection.owner`).
- **CREATE_COLLECTION**: `owner` stored as `requester` only — caller of the tx becomes the on-chain owner (contract uses `get_caller_address()`).
- Collection contract: `COLLECTION_CONTRACT` constant (`0x05e73b7...`) — can be overridden per-request via `collectionContract` field
- `cairo.uint256(collectionId)` used for u256 encoding; `encodeByteArray()` used for Cairo ByteArray felts
- **`tokenStandard` validation (added 2026-04-30)**: cancel, fulfill, and offer schemas now validate `tokenStandard` as `.enum(["ERC721", "ERC1155"])`. Sending any other value (e.g. `"ERC20"`, `"ERC-1155"`) returns 400 "Invalid body". This was a direct regression trigger that revealed a frontend bug where bid order cancellations sent `"ERC20"` as the standard.
- **fulfill 400 guard (added 2026-04-30)**: if `tokenStandard` is omitted on fulfill and the order is not in the DB, the endpoint now returns 400 "Order not found in index — provide tokenStandard hint" instead of silently routing to ERC-721.

### On-chain NFT comments (added 2026-03-22)

Comments are indexed from `CommentAdded` events emitted by the NFTComments contract — address set via the `COMMENTS_CONTRACT_ADDRESS` env (the live **deployed** instance). ⚠️ `0x024f97eb5abe659fb650bf162b5fc16501f8f3863a7369901ce6099462e62799` is **NOT deployed** (a 2026-05 misconfig that caused a platform-wide comments outage — see memory `project_comments_contract_outage`); never point the env at it. Separate from the marketplace poller — `pollCommentEvents` in `src/mirror/commentPoller.ts` runs in parallel.

**Token existence filter**: `handleCommentAdded` in `src/mirror/handlers/commentAdded.ts` checks if the token exists in the DB before indexing. Comments on unindexed tokens are silently skipped (avoids orphan rows and spam from non-Medialane NFTs).

**`Comment` model**: `id`, `chain`, `contractAddress`, `tokenId`, `author`, `content`, `txHash`, `logIndex`, `blockNumber`, `blockTimestamp`, `isHidden`. Idempotency: `@@unique([txHash, logIndex])`.

**`COMMENTS_CONTRACT_ADDRESS` env var**: must be set (Railway + Vercel) to the **deployed** NFTComments instance. Do NOT use `0x024f97…62799` — no contract is deployed there (root cause of the 2026-05-17 comments outage). The correct address is whatever is currently configured in prod env; keep code defaults in sync with it.

**COMMENT report type**: `ReportTargetType` enum extended with `COMMENT`. `targetKey` format = `COMMENT::<commentId>` (double-colon to avoid collision). After 3 unique reports, `isHidden = true` is set automatically in `src/api/routes/reports.ts`. **Split on `"::"` not `":"` when parsing COMMENT targetKeys.**

### Prisma enum addition pitfall (discovered 2026-03-22)

`prisma migrate dev` fails for enum additions when the shadow DB blocks on `CREATE INDEX CONCURRENTLY`. Workaround:
1. Write the migration SQL manually (e.g. `ALTER TYPE "ReportTargetType" ADD VALUE 'COMMENT';`)
2. Save to `prisma/migrations/<timestamp>_<name>/migration.sql`
3. Run `prisma migrate resolve --applied <migration-name>` locally (marks it applied without running it)
4. Commit — Railway's `prisma migrate deploy` will apply on next deploy

If a migration gets stuck as "failed" in Railway but was actually applied: `prisma migrate resolve --applied <name>` fixes it without data loss.

### ERC-1155 V2 SNIP-12 types (updated 2026-04-28)

The current Medialane1155V2 Cairo contract hashes nested `OrderParameters` with `OfferItem` and `ConsiderationItem`, matching the ERC-721 protocol structure while supporting ERC-1155 quantities. The SNIP-12 type definitions in `src/orchestrator/intent.ts` (`SNIP12_TYPES_1155`) must use domain `{ name: "Medialane", version: "2", revision: "1" }`.

**Why this matters:** If the backend signs the legacy flat ERC-1155 shape, the Poseidon hash differs from the hash computed by the Cairo contract. Signature verification fails and no marketplace event is emitted, so `txVerifier` correctly flags the intent as FAILED.

**Do not revert to the legacy flat shape:** bid-shaped ERC-1155 offers require V2 parity with ERC-721 (`ERC20/NATIVE -> ERC1155`). Listings remain `ERC1155 -> ERC20/NATIVE`.

The calldata layout for `register_order` (Medialane1155V2) is:
```
offerer, offer_item_type, offer_token, offer_identifier_or_criteria, offer_start_amount, offer_end_amount,
consideration_item_type, consideration_token, consideration_identifier_or_criteria, consideration_start_amount, consideration_end_amount, consideration_recipient,
start_time, end_time, salt, nonce, sig_len, sig[0], sig[1]
```

### Floor price storage (fixed 2026-03-20)
`STATS_UPDATE` stores `floorPrice` as `"1.500000 USDC"` (human-readable + symbol). If `considerationToken` is null or unknown to `getTokenByAddress()`, `floorPrice` is set to `null` — raw wei is **never** stored. Previous behaviour stored raw wei (e.g. `"1000000000000000000"`) which the frontend rendered as `"1,000,000,000,000,000,000"`. Fix is in `src/orchestrator/stats.ts`.

### Metadata
- `?wait=true` on GET /tokens → JIT resolution, blocks up to 3s via `Promise.race`
- Results (including failures) cached in `MetadataCache` to avoid repeat fetches
- Pinata free plan: `pin_by_cid` not supported → METADATA_PIN jobs always fail

### Cairo ByteArray token_uri decoding (CRITICAL — fixed 2026-03-06)
Modern OZ ERC-721 contracts return `token_uri` as a Cairo `ByteArray` struct. starknet.js v6 requires the struct definition in the ABI **alongside** the function entry, or it returns only `data_len` as a bigint and drops `pending_word` bytes — truncating IPFS CIDs by ~4 chars and making them invalid.

The ABI in `src/orchestrator/metadata.ts` (`ERC721_METADATA_ABI_BYTEARRAY`) includes the required struct. Do not remove it. Strategy: try ByteArray ABI first, fall back to `ERC721_METADATA_ABI_FELT_ARRAY` for legacy contracts.

### BigInt serialization in Hono responses
Prisma `Order` rows contain `startTime`, `endTime`, `createdBlockNumber` as BigInt. Raw Prisma objects cannot be passed to `c.json()`. Always use the `serializeOrder()` function in `src/api/utils/serialize.ts` when returning orders. It accepts an optional `tokenData: { name, image, description } | undefined` second param to include batchTokenMeta enrichment.

### batchTokenMeta (token name/image/description on orders)
All order-returning endpoints (list, single, by-token, by-user) call `batchTokenMeta(orders)` from `src/api/utils/serialize.ts` to fetch token metadata in one DB query. Result is a `Map<key, data>` passed into each `serializeOrder(o, tokenMeta.get(...))`. **Never** add per-row `useToken` calls on the frontend — use `order.token?.name` / `order.token?.image` directly.

**Important**: `activeOrders.map(serializeOrder)` will fail with a TypeScript error because `.map` passes `(value, index, array)` and `index: number` conflicts with the optional `tokenData` param. Always wrap: `activeOrders.map((o) => serializeOrder(o))`.

### Admin token refresh
`POST /admin/tokens/:contract/:tokenId/refresh` — calls `handleMetadataFetch` directly, bypassing the job queue. Use to force-fix FAILED tokens on Railway without waiting for the orchestrator.

---

## Database

Prisma v5 + PostgreSQL.

> **CRITICAL**: When adding a field to `schema.prisma`, you MUST also run `db:migrate` to generate a migration SQL file. Editing the schema alone does NOT update the production DB. Railway runs `prisma migrate deploy` on startup — if no migration file exists, the new column is absent in prod and any Prisma call that touches it will throw a runtime error (e.g. "column does not exist"). This caused a P0 incident on 2026-03-12 where `reaperAttempts`, `attemptCount`, and `isTerminal` were added to the schema without a migration, breaking all `job.create` calls and stalling the entire indexer/orchestrator.

Key tables: `Tenant`, `ApiKey`, `Order`, `Token`, `Collection`, `Transfer`, `Comment`, `Job`, `IndexerCursor`, `MetadataCache`, `UsageLog`, `WebhookEndpoint`, `TransactionIntent`, `AuditLog`, `Report`

psql on this machine: `/opt/homebrew/Cellar/postgresql@16/16.13/bin/psql`

```sql
-- Indexer progress
SELECT "lastBlock", "updatedAt" FROM "IndexerCursor" WHERE id = 'singleton';

-- Pending/failed jobs
SELECT type, status, attempts, error FROM "Job"
WHERE status IN ('PENDING', 'FAILED') ORDER BY "createdAt" DESC LIMIT 20;

-- Metadata status
SELECT "metadataStatus", COUNT(*) FROM "Token" GROUP BY "metadataStatus";

-- Reset stuck jobs
UPDATE "Job" SET status = 'PENDING'
WHERE status = 'PROCESSING' AND "updatedAt" < NOW() - INTERVAL '10 minutes';
```

---

## Environment

Required:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ALCHEMY_RPC_URL` | Starknet mainnet RPC |
| `PINATA_JWT` | Pinata JWT |
| `PINATA_GATEWAY` | Pinata gateway hostname |
| `API_SECRET_KEY` | Min 16 chars, admin auth |

Optional: `VOYAGER_API_KEY`, `CHIPIPAY_API_KEY`, `CHIPIPAY_API_URL`, `LOG_LEVEL`, `INDEXER_START_BLOCK` (default: `9196722`), `INDEXER_POLL_INTERVAL_MS`, `INDEXER_BLOCK_BATCH_SIZE`, `CORS_ORIGINS`, `PORT`, `STARKNET_NETWORK`, `MARKETPLACE_721_CONTRACT_MAINNET`, `MARKETPLACE_1155_CONTRACT_MAINNET`, `COLLECTION_721_CONTRACT_MAINNET`, `COLLECTION_721_START_BLOCK` (default: `10046166`), `COLLECTION_1155_CONTRACT_MAINNET`, `POP_FACTORY_ADDRESS`, `POP_START_BLOCK`, `DROP_FACTORY_ADDRESS`, `DROP_START_BLOCK`

**Collection Drop Railway env vars (add to Railway):**
```
DROP_FACTORY_ADDRESS=0x03587f42e29daee1b193f6cf83bf8627908ed6632d0d83fcb26225c50547d800
DROP_START_BLOCK=8341335
```

**Current immutable contract defaults (no Railway override needed unless testing):**
```
MARKETPLACE_721_CONTRACT_MAINNET=0x00f8ccaae0bc811c79605974cc1dab769b9cea8877f033f8e3c17f30457caba6
MARKETPLACE_1155_CONTRACT_MAINNET=0x02bfa521c25461a09d735889b469418608d7d92f8b26e3d37ef174a4c2e22f99
COLLECTION_721_CONTRACT_MAINNET=0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2  # MIP v0.3.0
COLLECTION_721_START_BLOCK=10046166
COLLECTION_1155_CONTRACT_MAINNET=0x067064adcaaed61e17bf50ea802ea6482336126aec5b4d032b4ff8fbb5009131  # v0.2.0
COMMENTS_CONTRACT_ADDRESS=<deployed NFTComments instance — NOT 0x024f97…62799 (undeployed)>
INDEXER_START_BLOCK=9196722
```

> Env vars renamed 2026-05-22: `COLLECTION_START_BLOCK` → `COLLECTION_721_START_BLOCK`, dropped unused `ERC1155_FACTORY_START_BLOCK`.

Local values: use `.env.local` — never put secrets in this file.

---

## Supported Tokens (`src/config/constants.ts`)

All 5 tokens confirmed from source:

| Symbol | Address | Decimals |
|--------|---------|----------|
| USDC (native) | `0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb` | 6 |
| USDT | `0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8` | 6 |
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` | 18 |
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` | 18 |
| WBTC | `0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac` | 8 |

Note: USDC.e (bridged) removed from active token list. `"USDC.E": 6` retained in `src/api/utils/serialize.ts` as a permanent legacy read entry for existing DB orders denominated in USDC.e.

---

## Key Contracts (mainnet)

- Marketplace ERC-721 (current): `0x00f8ccaae0bc811c79605974cc1dab769b9cea8877f033f8e3c17f30457caba6`
- **Marketplace ERC-1155 (Medialane1155V2, current)**: `0x02bfa521c25461a09d735889b469418608d7d92f8b26e3d37ef174a4c2e22f99`
- **MIP IPCollection registry (ERC-721) v0.3.0** (deployed 2026-05-22): `0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2`
- **IP-Programmable-ERC1155-Collections factory v0.2.0** (deployed 2026-05-22): `0x067064adcaaed61e17bf50ea802ea6482336126aec5b4d032b4ff8fbb5009131`
- NFTComments: set via `COMMENTS_CONTRACT_ADDRESS` env (the deployed instance) — **not** `0x024f97…62799` (undeployed; caused the 2026-05-17 comments outage)
- Indexer start block: `9196722`
- SNIP-12 domain ERC-721: `{ name: "Medialane", version: "1", revision: "1" }`
- SNIP-12 domain ERC-1155: `{ name: "Medialane", version: "2", revision: "1" }`
- Event selectors computed via `hash.getSelectorFromName()` at startup

---

## Deployment

**Production**: Railway. `railway.json` start command:
```
bun run scripts/pre-migrate.ts; bunx prisma migrate deploy; bun run src/scripts/seed-rewards.ts; bun run src/index.ts
```
Migrations run on every deploy. `seed-rewards.ts` runs after every migration (upsert — safe to repeat). Health check: `GET /health` (60s timeout).

**After first deploy or after significant activity**, trigger retroactive score computation:
```bash
curl -X POST https://<railway-url>/admin/rewards/compute -H "x-api-key: <API_SECRET_KEY>"
```
