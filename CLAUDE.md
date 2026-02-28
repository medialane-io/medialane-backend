# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
bun run dev          # watch mode
bun run start        # production

# Database
bun run db:migrate   # run Prisma migrations (dev)
bun run db:generate  # regenerate Prisma client after schema changes
bun run db:push      # push schema without a migration file
bun run db:studio    # open Prisma Studio

# Utility scripts
bun run backfill     # backfill historical on-chain data
bun run reset-cursor # reset the indexer block cursor to start
```

There is no linting or test runner configured.

## Architecture

The service runs three concurrent loops on startup (`src/index.ts`):

1. **HTTP API** — Hono server on `PORT` (default 3000), all routes under `/v1/*`
2. **Mirror** — Block indexer that polls Starknet for marketplace events
3. **Orchestrator** — Background job processor (metadata fetching, stats updates)

### Mirror (`src/mirror/`)

Polls the Starknet marketplace contract for `OrderCreated`, `OrderFulfilled`, `OrderCancelled`, and ERC-721 `Transfer` events in configurable block batches. Each tick:
- Fetches paginated events via Alchemy RPC (`poller.ts`)
- Parses raw felt arrays into typed events (`parser.ts`)
- Writes all events + advances `IndexerCursor` in a single atomic DB transaction
- After the transaction, enqueues `METADATA_FETCH` and `STATS_UPDATE` jobs for affected tokens/collections

The cursor (`IndexerCursor` table) is a singleton row that tracks `lastBlock`. Use `bun run reset-cursor` to reindex from scratch.

### Orchestrator (`src/orchestrator/`)

Polls the `Job` table every 2 seconds. Jobs have optimistic-lock claiming (prevents double-processing) and exponential backoff retries up to `maxAttempts`.

- **`METADATA_FETCH`** — Calls `token_uri` / `tokenURI` on the ERC-721 contract, then resolves the URI through `src/discovery/` (IPFS gateway fallback chain → Pinata → Cloudflare → ipfs.io). Stores name, description, image, attributes, and IP metadata fields on the `Token` record.
- **`STATS_UPDATE`** — Recomputes floor price, total volume, holder count, and total supply for a `Collection`.
- **`METADATA_PIN`** — Not yet implemented.

### Discovery (`src/discovery/`)

Resolves token URIs to metadata JSON with caching. Results (including failures) are cached in the `MetadataCache` table to avoid repeated fetches. Supports `ipfs://`, `data:`, and HTTP URIs.

### Intent Builder (`src/orchestrator/intent.ts`)

Builds SNIP-12 typed data for the four marketplace actions (create listing, make offer, fulfill order, cancel order). Fetches the user's on-chain nonce from the marketplace contract before building. The frontend signs the typed data and submits the signature via `PATCH /v1/intents/:id/signature`.

### API Routes (`src/api/routes/`)

All routes return `{ data: ... }` on success. Write endpoints on `/v1/intents/*` are rate-limited (20 req/min per IP). Admin routes use `authMiddleware` which checks the `x-api-key` header against `API_SECRET_KEY`.

## Key Conventions

- **Runtime**: Bun (not Node/npm). Use `bun` and `bunx`, never `node` or `npx`.
- **Path alias**: `@/*` resolves to `src/*` (configured in `tsconfig.json`).
- **Imports**: Use `.js` extension in import paths (ESM bundler resolution).
- **BigInt**: All Starknet amounts and block numbers are handled as `BigInt`; the DB stores them as `String` (Prisma `BigInt` maps to `bigint` in TS but uses `String` in JSON).
- **Address normalization**: Always pass addresses through `normalizeAddress()` (`src/utils/starknet.ts`) before storing to DB. Starknet addresses are 32-byte hex; normalization ensures consistent casing/padding.
- **Logging**: Use `createLogger(name)` from `src/utils/logger.ts` (pino-based). Never use `console.log` in application code.

## Environment

Copy `.env.example` to `.env`. Required variables:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ALCHEMY_RPC_URL` | Starknet RPC endpoint |
| `PINATA_JWT` | Pinata JWT for IPFS gateway access |
| `API_SECRET_KEY` | Min 16 chars, used for admin auth |

Optional: `VOYAGER_API_KEY`, `CHIPIPAY_API_KEY`, `CHIPIPAY_API_URL`.
