<img width="1260" height="640" alt="Medialane Backend" src="https://github.com/user-attachments/assets/a72bca86-bb82-42c4-8f61-9558484df5b9" />

# Medialane Backend

**Starknet Indexer + Marketplace API for Medialane**

The backend service that powers [Medialane.io](https://medialane.io), a programmable IP marketplace on Starknet. It continuously indexes on-chain events, resolves token metadata from IPFS, and exposes a REST API for dApps and SDK consumers.

---

## Architecture

Three concurrent loops run on startup:

```
Starknet RPC ──► Mirror (Indexer) ──► PostgreSQL ◄── Orchestrator (jobs)
                                           │
                                      Hono REST API ◄── dApps / @medialane/sdk
```

### Mirror (Indexer)
Polls the ERC-721 and ERC-1155 marketplace contracts every 6 seconds in batches of 500 blocks. Each tick:
1. Fetches `OrderCreated`, `OrderFulfilled`, `OrderCancelled` (both contracts) and ERC-721 `Transfer` events
2. Parses felt data (including Cairo ByteArray token URIs)
3. Writes to PostgreSQL atomically and advances the cursor
4. Enqueues `METADATA_FETCH` and `STATS_UPDATE` jobs

**ERC-1155 partial fills**: `Order.remainingAmount` tracks how many units remain after each fill. Orders stay `ACTIVE` until `remainingAmount == 0`, at which point they transition to `FULFILLED`. The `handleOrderFulfilled1155` handler reads `remaining_amount` from the `OrderFulfilled` event data.

### Orchestrator (Job Queue)
Polls the `Job` table every 2s with optimistic locking, exponential backoff, and a max of 3 attempts.

| Job | What it does |
|---|---|
| `METADATA_FETCH` | Resolves `token_uri` on-chain, fetches JSON from IPFS (Pinata → Cloudflare → ipfs.io fallback), stores on `Token` |
| `STATS_UPDATE` | Recomputes floor price, total volume, holder count, total supply for a `Collection`. Floor price is stored as `"1.5 USDC"` (human-readable + symbol), or `null` when the consideration token is unknown, keeping raw wei out of the column. |
| `COLLECTION_METADATA_FETCH` | Fetches collection name/symbol/baseUri on-chain; recovers image/description/owner from `CREATE_COLLECTION` intent typedData; upserts, so it can create new collection records from scratch |
| `METADATA_PIN` | Not yet implemented (Pinata free plan doesn't support `pin_by_cid`) |

### REST API (Hono)
Multi-tenant API with API key auth. All `/v1/*` routes require a valid `x-api-key` or `Authorization: Bearer` header.

---

## API Overview

### Orders
```
GET  /v1/orders                          List orders (status, collection, currency, sort, offerer, page, limit)
GET  /v1/orders/:orderHash               Single order
GET  /v1/orders/token/:contract/:tokenId Active orders for a token
GET  /v1/orders/user/:address            All orders by user
```

### Tokens
```
GET  /v1/tokens/owned/:address                    Tokens owned by address
GET  /v1/tokens/:contract/:tokenId                Token + metadata (?wait=true for JIT fetch)
GET  /v1/tokens/:contract/:tokenId/history        Transfer + order history
GET  /v1/tokens/:contract/:tokenId/comments       On-chain comments for token (page, limit; excludes hidden)
GET  /v1/tokens/:contract/:tokenId/remixes        Public remixes of token (page, limit)
```

### Collections
```
GET  /v1/collections                      All collections (sort, page, limit, isKnown, owner)
GET  /v1/collections?sort=recent          Sort: recent (default) | supply | volume | floor | name
GET  /v1/collections?isKnown=true         Verified collections only
GET  /v1/collections?owner=:address       Collections owned by address (includes collectionId)
GET  /v1/collections/:contract            Single collection
GET  /v1/collections/:contract/tokens     Tokens in collection
```

### Activities
```
GET  /v1/activities                       Global activity feed (type, page, limit)
GET  /v1/activities/:address              Activity by user
```

### Remix Offers
```
POST /v1/remix-offers                     Submit a custom license offer (SIWS token required)
POST /v1/remix-offers/auto                Auto-approve offer for open-license assets (SIWS token required)
POST /v1/remix-offers/self/confirm        Record completed self-remix (owner only, SIWS token required)
GET  /v1/remix-offers                     List offers for authenticated user (?role=creator|requester, ?status, page, limit)
GET  /v1/remix-offers/:id                 Single offer
POST /v1/remix-offers/:id/approve         Creator approves offer (sets approvedCollection, SIWS token required)
POST /v1/remix-offers/:id/reject          Creator rejects offer (SIWS token required)
POST /v1/remix-offers/:id/confirm         Mark offer completed after mint (SIWS token required)
GET  /v1/tokens/:contract/:tokenId/remixes  Public remixes for a token (page, limit)
```

All remix-offer mutation endpoints require both a valid `x-api-key` header and `Authorization: Bearer <siws-token>`. The SIWS token is used to derive the caller's Starknet wallet address. Price/currency fields are visible only in responses to the creator or requester.

**RemixOffer statuses**: `PENDING` (awaiting creator), `AUTO_PENDING` (open-license, auto-approved), `APPROVED` (creator approved), `COMPLETED` (remix minted + listed), `REJECTED`, `EXPIRED`, `SELF_MINTED` (owner self-remix recorded).

### Search
```
GET  /v1/search?q=...                     Search tokens + collections + creators (min 2 chars, max 50 results)
```

### Creator Profiles
```
GET  /v1/creators                         List creators (search, page, limit)
GET  /v1/creators/by-username/:username   Resolve username slug → creator profile
GET  /v1/creators/:address                Creator profile by wallet address
PATCH /v1/creators/:address/profile       Update profile (SIWS token required)
```

### Intents (Transaction orchestration)
The intent system handles SNIP-12 typed data signing flow for marketplace operations, and pre-signed calls for mint + collection creation.

```
POST /v1/intents/listing                  Create listing intent (SNIP-12)
POST /v1/intents/offer                    Create offer intent (SNIP-12)
POST /v1/intents/fulfill                  Create fulfill intent
POST /v1/intents/cancel                   Create cancel intent
POST /v1/intents/mint                     Pre-signed mint calls (no SNIP-12)
POST /v1/intents/create-collection        Pre-signed collection deployment
GET  /v1/intents/:id                      Get intent status
PATCH /v1/intents/:id/signature           Submit SNIP-12 signature
```

### Metadata (IPFS)
```
GET  /v1/metadata/signed-url              Pinata presigned URL (30s TTL)
POST /v1/metadata/upload                  Upload JSON to IPFS → ipfs:// URI
POST /v1/metadata/upload-file             Upload file to IPFS (multipart)
POST /v1/metadata/upload-directory        Upload a directory of JSON files → ipfs:// base URI
GET  /v1/metadata/resolve?uri=...         Resolve ipfs://, data:, https://
GET  /v1/metadata/image/*cid              Stream an IPFS image through the dedicated gateway (authenticated)
```

### Portal (Tenant self-service)
```
GET    /v1/portal/me                      Tenant profile + plan
GET    /v1/portal/keys                    API keys
POST   /v1/portal/keys                    Create API key (plaintext shown once)
DELETE /v1/portal/keys/:id                Revoke key
GET    /v1/portal/usage                   30-day usage by day
GET    /v1/portal/webhooks                List webhooks (PREMIUM)
POST   /v1/portal/webhooks                Create webhook (PREMIUM, secret shown once)
DELETE /v1/portal/webhooks/:id            Delete webhook (PREMIUM)
```

### Admin
```
POST   /admin/tenants                               Create tenant + initial API key
GET    /admin/tenants                               List all tenants
PATCH  /admin/tenants/:id                           Update plan or status
POST   /admin/tenants/:id/keys                      Create additional API key for tenant
DELETE /admin/keys/:keyId                           Revoke any key
GET    /admin/usage                                 Usage stats (?tenantId, ?days up to 90)
POST   /admin/tokens/:contract/:tokenId/refresh     Force metadata re-fetch (bypasses queue)
POST   /admin/collections                           Register collection by address
PATCH  /admin/collections/:contract                 Update isKnown, owner, or metadata
POST   /admin/collections/backfill-metadata         Enqueue COLLECTION_METADATA_FETCH for all pending/failed collections
POST   /admin/collections/backfill-registry         Scan all CollectionCreated events on-chain and upsert missing collections
POST   /admin/collections/:contract/refresh         Force COLLECTION_METADATA_FETCH for one collection
POST   /admin/collections/:contract/stats-refresh   Force STATS_UPDATE for one collection
GET    /admin/comments                              List comments (?hidden=true|false, ?author, ?contract, page, limit)
PATCH  /admin/comments/:id/hide                     Set isHidden = true
PATCH  /admin/comments/:id/show                     Set isHidden = false
```

---

## Rate Limiting

| Plan | Limit | Window |
|---|---|---|
| FREE | 50 requests | per calendar month |
| PREMIUM | 3,000 requests | per minute |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Web Framework | [Hono v4](https://hono.dev) |
| Database | PostgreSQL + [Prisma v5](https://prisma.io) |
| Blockchain | [starknet.js v6](https://www.starknetjs.com) |
| IPFS | [Pinata SDK v2](https://pinata.cloud) |
| Logging | pino |
| Deployment | [Railway](https://railway.app) |

---

## Supported Tokens

| Symbol | Type | Address | Decimals |
|---|---|---|---|
| USDC | Circle-native (canonical) | `0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb` | 6 |
| USDT | Tether | `0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8` | 6 |
| ETH | Ether | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` | 18 |
| STRK | Starknet native | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c988d` | 18 |
| WBTC | Wrapped Bitcoin | `0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac` | 8 |

> USDC.e (bridged Starkgate) was removed from the active token list. Its address is retained in `serialize.ts` as a legacy read entry for existing orders denominated in USDC.e.

---

## Key Contracts (Mainnet)

| Contract | Address |
|---|---|
| Marketplace Protocol (ERC-721) | `0x03eda9a2b6ad90845a43591bac8083ebaf677d51fdf20f503b2c01889e3131fc` |
| Marketplace Protocol (ERC-1155) | `0x07c4ce1c19ea48cc11135ed22b19ff745f5aec508c3828593002e4f76fdb1b38` |
| Collection Protocol (ERC-721 registry) | `0x0225c3ae09506b8d97adc39649ca740dad5aac195b7f5f0441cc1852947acaea` |
| Collection Protocol (ERC-1155 factory) | `0x015368976d46fae5bfa1c58600f641d5aa5dbbf53ebc6b78aa3922194aad3551` |
| NFTComments | `0x02cdac70c94447189af0389dfea63f4d5e4154ea8a563de288a5ab1c39e37843` |
| Indexer start block | `11198146` |

This is a partial list. The full current registry, including Launchpad services
(IP Tickets, IP Club, IP Sponsorship, POP, Collection Drop) and Creator Coin,
all of which this indexer also mirrors, lives in `@medialane/sdk`'s
`src/chains.ts` (`getCoordinates("STARKNET")`), the single source of truth.

---

## Getting Started (Local Development)

```bash
git clone https://github.com/medialane-io/medialane-backend
cd medialane-backend
bun install

# Database setup
bunx prisma migrate dev
bunx prisma generate

# Start
bun dev
```

### Required Environment Variables

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ALCHEMY_RPC_URL` | Starknet mainnet RPC |
| `PINATA_JWT` | Pinata JWT for metadata uploads |
| `PINATA_GATEWAY` | Your account's dedicated gateway domain, from the Pinata dashboard's Gateways tab |
| `PINATA_GATEWAY_TOKEN` | Gateway Keys access-control token (Pinata dashboard > Access Controls), opening the dedicated gateway to serve any CID |
| `API_SECRET_KEY` | Min 16 chars, used for admin routes auth |
| `CORS_ORIGINS` | Comma-separated allowed origins (e.g. `https://medialane.io,https://www.medialane.io`) |

Optional env vars (all have sensible defaults):

| Variable | Default | Notes |
|---|---|---|
| `INDEXER_START_BLOCK` | `9196722` | Block to start scanning marketplace events from |
| `COLLECTION_START_BLOCK` | `8660000` | Block to start scanning `CollectionCreated` events from. Update to first block of the current collection registry contract when upgrading. |
| `INDEXER_POLL_INTERVAL_MS` | `6000` | Mirror poll cadence |
| `INDEXER_BLOCK_BATCH_SIZE` | `500` | Blocks per indexer tick |
| `STARKNET_NETWORK` | `mainnet` | `mainnet` or `sepolia` |
| `MARKETPLACE_721_CONTRACT_MAINNET` | current audited address | ERC-721 marketplace protocol override |
| `MARKETPLACE_1155_CONTRACT_MAINNET` | current audited address | ERC-1155 marketplace protocol override |
| `COLLECTION_721_CONTRACT_MAINNET` | current audited address | ERC-721 mint / collection registry override |
| `COLLECTION_1155_CONTRACT_MAINNET` | current audited address | ERC-1155 mint / collection factory override |

### Commands

```bash
bun dev                # Watch mode
bun start              # Production
bun run db:migrate     # Prisma migrate dev
bun run db:generate    # Regenerate Prisma client
bun run db:push        # Push schema (no migration file)
bun run db:studio      # Prisma Studio at localhost:5555
bun run reset-cursor   # Reset indexer cursor to start block (mirror replays the window)
```

---

## Critical Implementation Notes

### Cairo ByteArray token_uri
Modern OpenZeppelin ERC-721 contracts return `token_uri` as a Cairo `ByteArray` struct. The ABI must include the `core::byte_array::ByteArray` struct definition alongside the function entry; otherwise starknet.js v6 drops `pending_word` bytes, truncating IPFS CIDs into invalid ones. The backend tries ByteArray ABI first, then falls back to felt array for legacy contracts.

### Order parsing
`OrderCreated` events only include `order_hash` in the keys, so full order parameters are fetched by calling `get_order_details(order_hash)` on-chain. Bid orders (ERC20 → ERC721) derive `nftContract` from the **consideration** side.

### Address normalization
All route handlers apply `normalizeAddress(chain, address)` (`src/utils/starknet.ts`, re-exported from `@medialane/sdk`) to every address parameter before DB queries. Chain-dispatched (v0.37.0): Starknet pads to `0x` + 64 lowercase hex; EVM uses EIP-55; Solana base58. DB stores each chain's canonical form. Today every live caller is Starknet (`"STARKNET"`); the chain dimension is wired so non-Starknet assets/accounts slot in without a rewrite.

### BigInt serialization
Prisma fields `startTime`, `endTime`, and `createdBlockNumber` are stored as `String` in the DB (Starknet felts). Always run orders through the `serializeOrder()` / `serializeToken()` helper functions before returning them in API responses.

### Price sorting
`priceRaw` is a String column, so sorting stays on `$queryRaw` with an `::numeric NULLS LAST` cast.

### Collections sort
`GET /v1/collections` supports a `sort` query param with values: `recent` (default, `createdAt DESC`), `supply` (`totalSupply DESC`), `name` (`name ASC`), `floor` (`floorPrice::numeric ASC NULLS LAST`, raw SQL), `volume` (`totalVolume::numeric DESC NULLS LAST`, raw SQL). Floor and volume use `$queryRaw` because the columns are stored as `String` in the DB. Page/limit are clamped: `limit = min(100, max(1, …))`, `page = max(1, …)`.

---

## Deployment

**Production on Railway**. The `railway.json` start command:
```
bunx prisma migrate deploy; bun run src/index.ts
```
Migrations run automatically on every deploy. Health check: `GET /health` (60s timeout).

After adding or changing environment variables in Railway, **manually trigger a redeploy** to pick them up.

---

## Related Repositories

| Repo | Description |
|---|---|
| [medialane-io](https://github.com/medialane-io/medialane-io) | Consumer app: Media Wallet, email login, sponsored transactions |
| [medialane-starknet](https://github.com/medialane-io/medialane-starknet) | Wallet-sovereign Starknet app: creator launchpad + marketplace |
| [medialane-sdk](https://github.com/medialane-io/medialane-sdk) | TypeScript SDK (`@medialane/sdk`), wraps this API |
| [medialane-portal](https://github.com/medialane-io/medialane-portal) | Developer portal (API keys, docs, webhooks) |

---

## License

[MIT](LICENSE)
