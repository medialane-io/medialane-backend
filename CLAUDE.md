# CLAUDE.md

Guidance for Claude Code when working in this repository.
**Source of truth: actual source files, not RUNBOOK.md** (RUNBOOK was an early draft and is outdated in several places — see Critical Corrections below).

## Commands

```bash
~/.bun/bin/bun run dev          # watch mode
~/.bun/bin/bun run start        # production

~/.bun/bin/bun run db:migrate   # Prisma migrate dev (prompts for migration name)
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
| GET | `/v1/collections` | `page`, `limit` |
| GET | `/v1/collections/:contract` | |
| GET | `/v1/collections/:contract/tokens` | `page`, `limit` |
| GET | `/v1/tokens/owned/:address` | `page`, `limit` |
| GET | `/v1/tokens/:contract/:tokenId` | `?wait=true` blocks 3s for JIT metadata |
| GET | `/v1/tokens/:contract/:tokenId/history` | Mixed transfers + orders, sorted by timestamp |
| GET | `/v1/activities` | `?type=transfer\|sale\|listing\|offer`, `page`, `limit` |
| GET | `/v1/activities/:address` | `page`, `limit` |
| GET | `/v1/search` | `?q=` (min 2 chars), `limit` (max 50). Returns `{ data: { tokens, collections }, query }` |
| POST | `/v1/intents/listing` | Rate limited 20/min per IP |
| POST | `/v1/intents/offer` | Rate limited 20/min per IP |
| POST | `/v1/intents/fulfill` | Rate limited 20/min per IP |
| POST | `/v1/intents/cancel` | Rate limited 20/min per IP |
| GET | `/v1/intents/:id` | Auto-expires PENDING → EXPIRED on read |
| PATCH | `/v1/intents/:id/signature` | `{ signature: string[] }` → status SIGNED, calls populated |
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

---

## Key Conventions

- **Runtime**: Bun only. `~/.bun/bin/bun`, never `node`/`npm`/`npx`.
- **Path alias**: `@/*` → `src/*` (`tsconfig.json`).
- **Imports**: `.js` extension in all import paths (ESM bundler resolution).
- **BigInt**: Starknet amounts + block numbers as `BigInt` in TS; stored as `String` in DB.
- **Address normalization**: Always `normalizeAddress()` (`src/utils/starknet.ts`) before DB writes. 64-char lowercase 0x-padded hex.
- **Logging**: `createLogger(name)` from `src/utils/logger.ts` (pino). Never `console.log`.
- **Error shape**: `{ error: string }` — not `{ message }`.
- **Success shape**: `{ data: T }` for single items; `{ data: T[], meta: { page, limit, total } }` for lists. Exception: search returns `{ data: { tokens, collections }, query }`.

---

## Critical Design Notes

### Event parsing
- `OrderCreated` keys = `[selector, order_hash, offerer]` — no order params in event
- Must call `get_order_details(order_hash)` on-chain to get full `OrderParameters`
- ERC-721 Transfer tokenId = u256 split: keys[3] = low, keys[4] = high

### Listing vs bid
- Listing: `offer.item_type = ERC721`, `consideration.item_type = ERC20` → nftContract = offer.token
- Bid: `offer.item_type = ERC20`, `consideration.item_type = ERC721` → nftContract = consideration.token (fixed 2026-03-01)

### Price sorting
`priceRaw` is a String DB column. Uses `$queryRaw` with `::numeric NULLS LAST`. Do not change to ORM sort.

### Intents
- TTL: 24 hours. `PENDING → SIGNED` (on signature submit) or `PENDING → EXPIRED` (on GET read after TTL)
- `PATCH /:id/signature` → `buildPopulatedCalls()` injects signature into stored calldata, returns updated intent

### Metadata
- `?wait=true` on GET /tokens → JIT resolution, blocks up to 3s via `Promise.race`
- Results (including failures) cached in `MetadataCache` to avoid repeat fetches
- Pinata free plan: `pin_by_cid` not supported → METADATA_PIN jobs always fail

---

## Database

Prisma v5 + PostgreSQL.

Key tables: `Tenant`, `ApiKey`, `Order`, `Token`, `Collection`, `Transfer`, `Job`, `IndexerCursor`, `MetadataCache`, `UsageLog`, `WebhookEndpoint`, `TransactionIntent`, `AuditLog`

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
|---|---|---|
| USDC (native) | `0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb` | 6 |
| USDC.e (bridged) | `0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8` | 6 |
| USDT | `0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8` | 6 |
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` | 18 |
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` | 18 |

Note: SDK `constants.ts` only lists 4 tokens (missing native USDC). The backend is the source of truth.

---

## Key Contracts (mainnet)

- Marketplace: `0x059deafbbafbf7051c315cf75a94b03c5547892bc0c6dfa36d7ac7290d4cc33a`
- Collection (ERC-721): `0x05e73b7be06d82beeb390a0e0d655f2c9e7cf519658e04f05d9c690ccc41da03`
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
