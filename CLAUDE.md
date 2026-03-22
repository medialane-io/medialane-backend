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
```

Always use `~/.bun/bin/bun` — bun is not in PATH by default on this machine.
No linting or test runner configured. Verify with curl against localhost:3000.

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
- Polls `Job` table every 2s, optimistic-lock claiming, exponential backoff, max 3 attempts

| Job | What it does |
|---|---|
| `METADATA_FETCH` | Calls `token_uri` on ERC-721, resolves URI via `src/discovery/` (Pinata → Cloudflare → ipfs.io), stores on `Token` |
| `STATS_UPDATE` | Recomputes floor price, total volume, holder count, total supply for a `Collection` |
| `COLLECTION_METADATA_FETCH` | Fetches collection metadata: calls `name()`/`symbol()`/`base_uri()` on-chain; recovers `image`/`description`/`owner` from `CREATE_COLLECTION` intent `typedData` (matched by name); falls back to on-chain `owner()` call. Uses **upsert** — can create new collection records from scratch |
| `METADATA_PIN` | Not yet implemented (Pinata free plan doesn't support `pin_by_cid`) |

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

Lookup: `hashApiKey(raw)` → DB lookup on `ApiKey.keyHash`. Rejected if key `status !== "ACTIVE"` or tenant `status !== "ACTIVE"` (SUSPENDED tenants → 401 even with valid key). `lastUsedAt` updated fire-and-forget (non-blocking).

PREMIUM-only endpoints use `requirePlan("PREMIUM")` middleware → 403 `{ error: "Upgrade required", requiredPlan: "PREMIUM" }` for FREE tenants.

---

## Rate Limiting (`src/api/middleware/rateLimit.ts`)

**Keyed by API key ID** (not IP). In-memory store — resets on restart, not shared across instances.

| Plan | Limit | Window | How tracked |
|---|---|---|---|
| FREE | 50 requests | per calendar month | DB count on `UsageLog` (portal routes excluded) |
| PREMIUM | 3,000 requests | per minute | In-memory `InMemoryRateLimitStore` |

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
| GET | `/v1/collections/:contract/tokens` | `page`, `limit` |
| GET | `/v1/tokens/owned/:address` | `page`, `limit` |
| GET | `/v1/tokens/:contract/:tokenId` | `?wait=true` blocks 3s for JIT metadata |
| GET | `/v1/tokens/:contract/:tokenId/history` | Mixed transfers + orders, sorted by timestamp |
| GET | `/v1/tokens/:contract/:tokenId/comments` | On-chain comments for token. `page`, `limit`. Excludes `isHidden=true` comments. Returns `{ data: ApiComment[], meta }` |
| GET | `/v1/activities` | `?type=transfer\|sale\|listing\|offer`, `page`, `limit` |
| GET | `/v1/activities/:address` | `page`, `limit` |
| GET | `/v1/search` | `?q=` (min 2 chars), `limit` (max 50). Returns `{ data: { tokens, collections }, query }` |
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
| GET | `/v1/portal/me` | `{ id, name, email, plan, status }` |
| GET | `/v1/portal/keys` | List keys (prefix only, no plaintext) |
| POST | `/v1/portal/keys` | `{ label? }` — max 5 active; returns plaintext ONCE |
| DELETE | `/v1/portal/keys/:id` | → status REVOKED |
| GET | `/v1/portal/usage/recent` | Last 10 UsageLog rows |
| GET | `/v1/portal/usage` | 30 days grouped by day `{ day: "YYYY-MM-DD", requests }[]` |
| GET | `/v1/portal/webhooks` | **PREMIUM only** |
| POST | `/v1/portal/webhooks` | **PREMIUM only**. `{ url, events[], label? }`. Returns secret ONCE (`whsec_...`) |
| DELETE | `/v1/portal/webhooks/:id` | **PREMIUM only** → status DISABLED |

### Admin (`API_SECRET_KEY` required)

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
| GET | `/admin/comments` | List comments. `?hidden=true\|false`, `?author=address`, `?contract=address`, `page`, `limit` |
| PATCH | `/admin/comments/:id/hide` | Set `isHidden = true` on a comment |
| PATCH | `/admin/comments/:id/show` | Set `isHidden = false` on a comment |

---

## Key Conventions

- **Runtime**: Bun only. `~/.bun/bin/bun`, never `node`/`npm`/`npx`.
- **Path alias**: `@/*` → `src/*` (`tsconfig.json`).
- **Imports**: `.js` extension in all import paths (ESM bundler resolution).
- **BigInt**: Starknet amounts + block numbers as `BigInt` in TS; stored as `String` in DB.
- **Address normalization**: Always `normalizeAddress()` (`src/utils/starknet.ts`) before DB writes AND before DB queries. 64-char lowercase 0x-padded hex. Applied in all route handlers: `GET /v1/tokens/owned/:address`, `GET /v1/orders/user/:address`, `GET /v1/activities/:address`, `GET /v1/collections?owner=`, `GET /v1/collections/:contract`, `GET /v1/collections/:contract/tokens`, all `/admin/collections/*` routes, and `offerer` filter in `GET /v1/orders`. **Never use `.toLowerCase()` alone** — it does not pad short addresses and causes "not found" mismatches.
- **Logging**: `createLogger(name)` from `src/utils/logger.ts` (pino). Never `console.log`.
- **Error shape**: `{ error: string }` — not `{ message }`.
- **Success shape**: `{ data: T }` for single items; `{ data: T[], meta: { page, limit, total } }` for lists. Exception: search returns `{ data: { tokens, collections }, query }`.

---

## Critical Design Notes

### CollectionCreated event indexing (added 2026-03-08)
The mirror now polls the collection registry for `CollectionCreated` events on every tick (alongside marketplace and Transfer events). When detected:
1. `resolveCollectionCreated()` in `src/mirror/handlers/collectionCreated.ts` calls `get_collection(collection_id)` on the registry to get the `ip_nft` (ERC-721 contract address)
2. Collection is upserted into DB with owner, name, symbol, baseUri, startBlock, and **collectionId** (the on-chain decimal string registry ID — e.g. `"1"`)
3. `COLLECTION_METADATA_FETCH` job is enqueued for full enrichment

**`collectionId` field** (added 2026-03-09): stored on `Collection` as `String?`. Required by `POST /v1/intents/mint` to encode the Cairo uint256 collection ID. Collections indexed before this migration will have `collectionId = null` until re-indexed via `POST /admin/collections/backfill-registry`.

**Event data layout**: `[collection_id.low, collection_id.high, owner, ...name_bytearray, ...symbol_bytearray, ...base_uri_bytearray]`. **ip_nft is NOT in the event** — must call `get_collection()` on the registry.

**If the indexer cursor already passed the collection creation blocks**: run `POST /admin/collections/backfill-registry` once — it scans all historical events and upserts everything in one call.

### Event parsing
- `OrderCreated` keys = `[selector, order_hash, offerer]` — no order params in event
- Must call `get_order_details(order_hash)` on-chain to get full `OrderParameters`
- ERC-721 Transfer tokenId = u256 split: keys[3] = low, keys[4] = high

### Listing vs bid
- Listing: `offer.item_type = ERC721`, `consideration.item_type = ERC20` → nftContract = offer.token
- Bid: `offer.item_type = ERC20`, `consideration.item_type = ERC721` → nftContract = consideration.token (fixed 2026-03-01)

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
- TTL: 24 hours. `PENDING → SIGNED` (on signature submit) or `PENDING → EXPIRED` (on GET read after TTL)
- `PATCH /:id/signature` → `buildPopulatedCalls()` injects signature into stored calldata, returns updated intent
- **MINT / CREATE_COLLECTION**: no SNIP-12 signing required — created directly as `SIGNED` with fully-populated calldata. `PATCH /:id/signature` returns 400 for these types.
- **MINT**: requires `owner` field — validated on-chain via `is_collection_owner(collection_id, owner)` before intent created. `owner` wallet must execute the returned `calls` (contract checks `get_caller_address() == collection.owner`).
- **CREATE_COLLECTION**: `owner` stored as `requester` only — caller of the tx becomes the on-chain owner (contract uses `get_caller_address()`).
- Collection contract: `COLLECTION_CONTRACT` constant (`0x05e73b7...`) — can be overridden per-request via `collectionContract` field
- `cairo.uint256(collectionId)` used for u256 encoding; `encodeByteArray()` used for Cairo ByteArray felts

### On-chain NFT comments (added 2026-03-22)

Comments are indexed from `CommentAdded` events emitted by the NFTComments contract (`0x070edbfa68a870e8a69736db58906391dcd8fcf848ac80a72ac1bf9192d8e232`). Separate from the marketplace poller — `pollCommentEvents` in `src/mirror/commentPoller.ts` runs in parallel.

**Token existence filter**: `handleCommentAdded` in `src/mirror/handlers/commentAdded.ts` checks if the token exists in the DB before indexing. Comments on unindexed tokens are silently skipped (avoids orphan rows and spam from non-Medialane NFTs).

**`Comment` model**: `id`, `chain`, `contractAddress`, `tokenId`, `author`, `content`, `txHash`, `logIndex`, `blockNumber`, `blockTimestamp`, `isHidden`. Idempotency: `@@unique([txHash, logIndex])`.

**`NFTComments_CONTRACT` env var**: must be set in Railway. Value: `0x070edbfa68a870e8a69736db58906391dcd8fcf848ac80a72ac1bf9192d8e232`.

**COMMENT report type**: `ReportTargetType` enum extended with `COMMENT`. `targetKey` format = `COMMENT::<commentId>` (double-colon to avoid collision). After 3 unique reports, `isHidden = true` is set automatically in `src/api/routes/reports.ts`. **Split on `"::"` not `":"` when parsing COMMENT targetKeys.**

### Prisma enum addition pitfall (discovered 2026-03-22)

`prisma migrate dev` fails for enum additions when the shadow DB blocks on `CREATE INDEX CONCURRENTLY`. Workaround:
1. Write the migration SQL manually (e.g. `ALTER TYPE "ReportTargetType" ADD VALUE 'COMMENT';`)
2. Save to `prisma/migrations/<timestamp>_<name>/migration.sql`
3. Run `prisma migrate resolve --applied <migration-name>` locally (marks it applied without running it)
4. Commit — Railway's `prisma migrate deploy` will apply on next deploy

If a migration gets stuck as "failed" in Railway but was actually applied: `prisma migrate resolve --applied <name>` fixes it without data loss.

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

Optional: `VOYAGER_API_KEY`, `CHIPIPAY_API_KEY`, `CHIPIPAY_API_URL`, `LOG_LEVEL`, `INDEXER_START_BLOCK`, `INDEXER_POLL_INTERVAL_MS`, `INDEXER_BLOCK_BATCH_SIZE`, `CORS_ORIGINS`, `PORT`, `STARKNET_NETWORK`, `MARKETPLACE_CONTRACT_MAINNET`, `COLLECTION_CONTRACT_MAINNET`

Local values (this machine — do not commit):
- `API_SECRET_KEY`: `060f0dd0c6707a93914b9f4ca6321d3c9ab68c359ad5f20c2d66f49cf0300549`
- Internal PREMIUM key: `ml_live_f530ed43e0be63ead84aa6492268d9e95145bf35c407f5eed418d1f67a7284b2`

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

- Marketplace: `0x04299b51289aa700de4ce19cc77bcea8430bfd1aef04193efab09d60a3a7ee0f`
- Collection (ERC-721): `0x05e73b7be06d82beeb390a0e0d655f2c9e7cf519658e04f05d9c690ccc41da03`
- NFTComments: `0x070edbfa68a870e8a69736db58906391dcd8fcf848ac80a72ac1bf9192d8e232` (class hash: `0x1edbebcd184c3ea65c19f59f2cbc11ef8b3a2883b4fe97db1caf0b29c6ea0dd` after 2026-03-22 upgrade)
- Indexer start block: `6204232`
- SNIP-12 domain: `{ name: "Medialane", version: "1", revision: "1" }`
- Event selectors computed via `hash.getSelectorFromName()` at startup

---

## Deployment

**Production**: Railway. `railway.json` start command:
```
bunx prisma migrate deploy; bun run src/index.ts
```
Migrations run on every deploy. Health check: `GET /health` (60s timeout).
