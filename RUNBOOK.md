# Medialane Backend — Local, Testing & Production Guide

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Local Setup](#2-local-setup)
3. [Understanding What's Running](#3-understanding-whats-running)
4. [Testing the API Locally](#4-testing-the-api-locally)
5. [Inspecting & Debugging](#5-inspecting--debugging)
6. [Utility Scripts](#6-utility-scripts)
7. [Production Deployment](#7-production-deployment)
8. [Production Checklist](#8-production-checklist)
9. [Ongoing Operations](#9-ongoing-operations)

---

## 1. Prerequisites

| Tool | Minimum | Notes |
|---|---|---|
| [Bun](https://bun.sh) | 1.1+ | Runtime and package manager |
| PostgreSQL | 14+ | Local install or managed (Supabase, Neon, Railway) |
| Alchemy account | — | Starknet RPC endpoint |
| Pinata account | — | IPFS gateway + JWT |

Install Bun if not already present:

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify:

```bash
bun --version
```

---

## 2. Local Setup

### 2.1 Install dependencies

```bash
cd medialane-backend
bun install
```

### 2.2 Create a local PostgreSQL database

Using the `psql` CLI:

```bash
psql -U postgres -c "CREATE DATABASE medialane;"
```

Or with Docker if you prefer not to install PostgreSQL locally:

```bash
docker run -d \
  --name medialane-pg \
  -e POSTGRES_DB=medialane \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2.3 Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in **all required values**:

```env
# PostgreSQL (adjust credentials to match what you created above)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/medialane"

# Alchemy — get from https://dashboard.alchemy.com
# Create a Starknet Mainnet app, copy the RPC URL
ALCHEMY_RPC_URL="https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_7/YOUR_KEY"

# Pinata — get from https://app.pinata.cloud/developers/api-keys
# Create an API key with full permissions, copy the JWT
PINATA_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
# Your Pinata dedicated gateway (e.g. "your-gateway.mypinata.cloud")
PINATA_GATEWAY="your-gateway.mypinata.cloud"

# Minimum 16 characters — used for admin endpoints
API_SECRET_KEY="dev-secret-key-change-me"

# Optional: reduce noise during local dev
LOG_LEVEL="debug"
```

Everything else in `.env.example` has sensible defaults and can be left as-is for local development.

### 2.4 Run database migrations

This creates all tables and generates the Prisma client:

```bash
bun run db:migrate
```

When Prisma prompts for a migration name, enter something like `init`.

If the schema already has migrations applied and you just want to sync, use:

```bash
bun run db:push
```

### 2.5 Start the server

```bash
bun run dev
```

You should see output like:

```
{"level":"info","network":"mainnet","port":3000,"msg":"Starting Medialane Backend"}
{"level":"info","msg":"Database connected"}
{"level":"info","port":3000,"msg":"HTTP server listening"}
{"level":"info","msg":"Mirror starting..."}
{"level":"info","msg":"Orchestrator starting..."}
{"level":"info","fromBlock":6204232,"toBlock":6204731,"latestBlock":1234567,"msg":"Indexing block range"}
```

The service is ready at `http://localhost:3000`.

---

## 3. Understanding What's Running

Three loops run concurrently once started:

### Mirror (block indexer)
- Polls Starknet every 6 seconds (`INDEXER_POLL_INTERVAL_MS`)
- Processes blocks in batches of 500 (`INDEXER_BLOCK_BATCH_SIZE`)
- Writes orders, tokens, and transfers to the DB atomically
- On first run, starts from block `INDEXER_START_BLOCK` (6204232 by default)

> **First-run catch-up**: The indexer will process all blocks from `INDEXER_START_BLOCK` to the current chain head. This takes a while. Use `LOG_LEVEL=info` to follow progress. For a faster start, see [Backfill](#61-backfill) below.

### Orchestrator (job processor)
- Polls the `Job` table every 2 seconds
- Processes `METADATA_FETCH` jobs (fetches tokenURIs + metadata from Starknet and IPFS)
- Processes `STATS_UPDATE` jobs (floor price, volume, supply per collection)
- Jobs retry up to 3 times with backoff

### HTTP API
- Runs on `PORT` (default 3000)
- `/health` is always public (no auth required)
- `/admin/*` endpoints require the `x-api-key: $API_SECRET_KEY` header
- All `/v1/*` endpoints require a tenant API key (`Authorization: Bearer ml_live_...` or `x-api-key`)
- Rate limiting is per API key: FREE tier = 60 req/min, PREMIUM = 3 000 req/min
- Response headers include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## 4. Testing the API Locally

No automated test suite exists. Verify the service with these curl commands.

### 4.1 Health check (no auth required)

```bash
curl http://localhost:3000/health | jq
```

Expected response when healthy:

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T12:00:00.000Z",
  "database": "ok",
  "indexer": {
    "lastBlock": "6204731",
    "latestBlock": 1234567,
    "lagBlocks": 1228836
  }
}
```

`lagBlocks` will be high on first run and decrease as the indexer catches up.

### 4.2 Create your first tenant and get an API key

All `/v1/*` endpoints require a tenant API key. Create one via the admin API:

```bash
# The plaintext key is returned ONCE — save it immediately
curl -s -X POST http://localhost:3000/admin/tenants \
  -H "x-api-key: $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Medialane.io","email":"dev@medialane.io","plan":"PREMIUM"}' | jq .

# Copy the plaintext value from data.apiKey.plaintext into ML_KEY
export ML_KEY="ml_live_..."
```

Confirm the key works and check your plan:

```bash
curl http://localhost:3000/v1/portal/me \
  -H "Authorization: Bearer $ML_KEY" | jq .data.plan
```

Verify unauthenticated requests are rejected:

```bash
curl http://localhost:3000/v1/orders | jq .error   # "Missing API key"
```

### 4.3 Orders

List active orders:

```bash
curl "http://localhost:3000/v1/orders?status=ACTIVE&limit=5" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Paginate and sort:

```bash
curl "http://localhost:3000/v1/orders?sort=price_asc&page=1&limit=10" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Get a specific order by hash:

```bash
curl "http://localhost:3000/v1/orders/0xYOUR_ORDER_HASH" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Get orders for a specific NFT:

```bash
curl "http://localhost:3000/v1/orders/token/0xCONTRACT/TOKEN_ID" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Get orders by user:

```bash
curl "http://localhost:3000/v1/orders/user/0xUSER_ADDRESS" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

### 4.4 Tokens

Get a token (triggers async metadata fetch if missing):

```bash
curl "http://localhost:3000/v1/tokens/0xCONTRACT/TOKEN_ID" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Get a token and wait up to 3s for metadata to resolve:

```bash
curl "http://localhost:3000/v1/tokens/0xCONTRACT/TOKEN_ID?wait=true" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Get tokens owned by a wallet:

```bash
curl "http://localhost:3000/v1/tokens/owned/0xWALLET_ADDRESS" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Get transfer + sale history for a token:

```bash
curl "http://localhost:3000/v1/tokens/0xCONTRACT/TOKEN_ID/history" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

### 4.5 Collections

```bash
curl "http://localhost:3000/v1/collections" \
  -H "Authorization: Bearer $ML_KEY" | jq

curl "http://localhost:3000/v1/collections/0xCONTRACT_ADDRESS" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

### 4.6 Activities (feed)

```bash
curl "http://localhost:3000/v1/activities?limit=10" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

### 4.7 Search

```bash
curl "http://localhost:3000/v1/search?q=punk" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

### 4.8 Intent creation

Create a listing intent (returns typed data for the frontend to sign):

```bash
curl -X POST http://localhost:3000/v1/intents/listing \
  -H "Authorization: Bearer $ML_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "offerer": "0xYOUR_WALLET",
    "nftContract": "0xCONTRACT",
    "tokenId": "1",
    "currency": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    "price": "1000000000000000000",
    "endTime": 1999999999
  }' | jq
```

Get an intent by ID:

```bash
curl "http://localhost:3000/v1/intents/INTENT_ID" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

Submit a signature:

```bash
curl -X PATCH http://localhost:3000/v1/intents/INTENT_ID/signature \
  -H "Authorization: Bearer $ML_KEY" \
  -H "Content-Type: application/json" \
  -d '{"signature": ["0xSIG_PART_1", "0xSIG_PART_2"]}' | jq
```

### 4.9 Metadata proxy

```bash
curl "http://localhost:3000/v1/metadata?uri=ipfs://QmXXX" \
  -H "Authorization: Bearer $ML_KEY" | jq
```

### 4.10 Rate limit headers

Rate limit headers are returned on every `/v1/*` response:

```bash
curl -sI "http://localhost:3000/v1/orders" \
  -H "Authorization: Bearer $ML_KEY" | grep -i x-ratelimit
# X-RateLimit-Limit: 3000
# X-RateLimit-Remaining: 2999
# X-RateLimit-Reset: 1234567890
```

### 4.11 Tenant self-service portal

```bash
# Your plan and status
curl http://localhost:3000/v1/portal/me \
  -H "Authorization: Bearer $ML_KEY" | jq

# Your API keys (prefix only, never the hash)
curl http://localhost:3000/v1/portal/keys \
  -H "Authorization: Bearer $ML_KEY" | jq

# Usage over the last 30 days
curl http://localhost:3000/v1/portal/usage \
  -H "Authorization: Bearer $ML_KEY" | jq

# Register a webhook endpoint (PREMIUM only)
curl -X POST http://localhost:3000/v1/portal/webhooks \
  -H "Authorization: Bearer $ML_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://webhook.site/YOUR_ID","events":["ORDER_CREATED","TRANSFER"]}' | jq
# Save data.secret — it is shown ONCE and used to verify x-medialane-signature
```

### 4.12 Admin operations

```bash
# List all tenants
curl http://localhost:3000/admin/tenants \
  -H "x-api-key: $API_SECRET_KEY" | jq

# Suspend a tenant (blocks all their keys instantly)
curl -X PATCH http://localhost:3000/admin/tenants/TENANT_ID \
  -H "x-api-key: $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"SUSPENDED"}' | jq

# Revoke a specific key
curl -X DELETE http://localhost:3000/admin/keys/KEY_ID \
  -H "x-api-key: $API_SECRET_KEY" | jq

# Usage stats for last 7 days
curl "http://localhost:3000/admin/usage?days=7" \
  -H "x-api-key: $API_SECRET_KEY" | jq
```

---

## 5. Inspecting & Debugging

### Prisma Studio (visual DB browser)

```bash
bun run db:studio
```

Opens a browser UI at `http://localhost:5555`. Useful for inspecting rows in `Job`, `Order`, `Token`, `IndexerCursor`, etc.

### Verbose logging

Set `LOG_LEVEL=debug` in `.env` and restart. Every block batch, job claim, and metadata fetch will be logged.

### Check pending/failed jobs

Via Prisma Studio or:

```bash
# in psql
SELECT type, status, attempts, error FROM "Job"
WHERE status IN ('PENDING', 'FAILED')
ORDER BY "createdAt" DESC
LIMIT 20;
```

### Check indexer progress

```bash
SELECT "lastBlock", "updatedAt" FROM "IndexerCursor" WHERE id = 'singleton';
```

### Check metadata fetch status

```bash
SELECT "metadataStatus", COUNT(*) FROM "Token" GROUP BY "metadataStatus";
```

---

## 6. Utility Scripts

### 6.1 Backfill

Use this to index a specific historical block range (faster than waiting for the live mirror, especially on first setup):

```bash
# Backfill from start block to latest
bun run backfill

# Backfill a specific range
bun run scripts/backfill.ts --from 6204232 --to 6300000
```

The backfill processes 500 blocks per batch, commits atomically, and enqueues metadata jobs. Run it while the server is **stopped** to avoid cursor conflicts, or use it as a one-off before starting the service for the first time.

### 6.2 Reset cursor

Restart indexing from a specific block (useful after schema changes or to re-index):

```bash
# Reset to INDEXER_START_BLOCK
bun run reset-cursor

# Reset to a specific block
bun run scripts/resetCursor.ts --block 6500000
```

> This only moves the cursor — it does not delete existing DB data. If you want a clean re-index, truncate the relevant tables first.

---

## 7. Production Deployment

### 7.1 Managed database

Use a hosted PostgreSQL provider. Good options:

- **[Neon](https://neon.tech)** — serverless, free tier available, connection pooling built-in
- **[Supabase](https://supabase.com)** — managed Postgres, free tier, has a dashboard
- **[Railway](https://railway.app)** — one-click Postgres, pairs well if deploying the app there too

Copy the connection string into your production `DATABASE_URL`.

### 7.2 Option A — VPS / bare metal (systemd)

Suitable for a single VM (DigitalOcean Droplet, Hetzner, AWS EC2, etc.).

**On the server:**

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Clone and install
git clone https://github.com/YOUR_ORG/medialane-backend.git /opt/medialane
cd /opt/medialane
bun install --production
```

Create `/etc/medialane.env` with production environment variables (see [Section 8](#8-production-checklist)).

Create a systemd service at `/etc/systemd/system/medialane.service`:

```ini
[Unit]
Description=Medialane Backend
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/medialane
EnvironmentFile=/etc/medialane.env
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=medialane

[Install]
WantedBy=multi-user.target
```

Run migrations, then enable and start:

```bash
# Run migrations (one-time or after schema changes)
cd /opt/medialane
source /etc/medialane.env
bunx prisma migrate deploy

# Enable and start
systemctl daemon-reload
systemctl enable medialane
systemctl start medialane
systemctl status medialane

# Follow logs
journalctl -u medialane -f
```

**Deploying updates:**

```bash
cd /opt/medialane
git pull
bun install --production
bunx prisma migrate deploy   # only needed if schema changed
systemctl restart medialane
```

### 7.3 Option B — Docker

Create a `Dockerfile` at the project root:

```dockerfile
FROM oven/bun:1.1-slim AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source
COPY . .

# Generate Prisma client
RUN bunx prisma generate

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
```

Build and run:

```bash
docker build -t medialane-backend .

docker run -d \
  --name medialane \
  --restart unless-stopped \
  --env-file .env.production \
  -p 3000:3000 \
  medialane-backend
```

Run migrations before starting (or as an init container):

```bash
docker run --rm \
  --env-file .env.production \
  medialane-backend \
  bunx prisma migrate deploy
```

### 7.4 Option C — Railway

1. Push the repo to GitHub.
2. Create a new Railway project → "Deploy from GitHub repo".
3. Add a PostgreSQL service from the Railway marketplace; copy the `DATABASE_URL` it provides.
4. In the app service settings → Variables, add all required env vars.
5. Railway auto-detects Bun and runs `bun run start`.
6. For migrations, add a one-off command in the Railway deploy pipeline:
   - Settings → Deploy → "Pre-deploy command": `bunx prisma migrate deploy`

### 7.5 Option D — Fly.io

```bash
# Install flyctl if not already: https://fly.io/docs/hands-on/install-flyctl/
fly launch           # creates fly.toml
fly secrets set DATABASE_URL="..." ALCHEMY_RPC_URL="..." PINATA_JWT="..." API_SECRET_KEY="..."
fly deploy
```

`fly.toml` minimum config:

```toml
app = "medialane-backend"
primary_region = "iad"

[build]
  # Fly auto-detects Bun

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false   # keep indexer running continuously

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Run migrations as a release command:

```toml
[deploy]
  release_command = "bunx prisma migrate deploy"
```

---

## 8. Production Checklist

### Environment variables

```env
# Strong random key (32+ chars)
API_SECRET_KEY="$(openssl rand -hex 32)"

# Only your actual frontend domains
CORS_ORIGINS="https://medialane.xyz,https://mediolano.app"

# Reduce log volume in prod
LOG_LEVEL="info"

# Alchemy production key (not dev/free tier)
ALCHEMY_RPC_URL="https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_7/PROD_KEY"

# Your production Pinata gateway
PINATA_JWT="..."
PINATA_GATEWAY="your-gateway.mypinata.cloud"

# Managed database URL (use connection pooling URL if available, e.g. Neon pooler)
DATABASE_URL="postgresql://..."
```

### Before first deploy

- [ ] Run `bunx prisma migrate deploy` against the production database before starting the app
- [ ] Confirm the health endpoint returns `"database": "ok"` after starting
- [ ] Set `INDEXER_START_BLOCK` to a recent block if you don't need full history (reduces catch-up time)
- [ ] If you need full history, run the backfill script before pointing the live mirror at the DB

### Security

- [ ] `API_SECRET_KEY` is at least 32 random characters
- [ ] `CORS_ORIGINS` contains only your actual domains (no `localhost` in prod)
- [ ] The database is not publicly accessible (firewall or VPC)
- [ ] The Pinata JWT is scoped to the minimum needed permissions
- [ ] If running behind a reverse proxy (nginx, Caddy, Cloudflare), ensure TLS termination and `x-forwarded-for` are configured (rate limiting is per API key ID, not IP, so this does not affect rate limit correctness)

### Reverse proxy (nginx example)

```nginx
server {
    listen 80;
    server_name api.medialane.xyz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.medialane.xyz;

    ssl_certificate     /etc/letsencrypt/live/api.medialane.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.medialane.xyz/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $remote_addr;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```

---

## 9. Ongoing Operations

### Checking health

```bash
curl https://api.medialane.xyz/health | jq
```

Monitor `lagBlocks` in the response — it should decrease over time and stabilize near 0. A growing lag means the Mirror loop is stalling (check logs for RPC errors).

### Viewing live logs

```bash
# systemd
journalctl -u medialane -f

# Docker
docker logs medialane -f

# Fly.io
fly logs

# Railway
railway logs
```

### Schema migrations in production

Always run migrations **before** restarting the app:

```bash
bunx prisma migrate deploy
```

This applies any unapplied migration files from `prisma/migrations/` in order. It is safe to run even if no new migrations exist.

### Monitoring stuck jobs

```bash
# psql: jobs stuck in PROCESSING for more than 10 minutes (shouldn't happen normally)
SELECT id, type, attempts, "updatedAt"
FROM "Job"
WHERE status = 'PROCESSING'
  AND "updatedAt" < NOW() - INTERVAL '10 minutes';

# Reset them to PENDING so they're retried
UPDATE "Job"
SET status = 'PENDING'
WHERE status = 'PROCESSING'
  AND "updatedAt" < NOW() - INTERVAL '10 minutes';
```

### Re-indexing a block range

If you suspect events were missed in a range (e.g. RPC was down):

1. Stop the service (to avoid cursor conflicts)
2. Run the backfill for the affected range:
   ```bash
   bun run scripts/backfill.ts --from 6300000 --to 6310000
   ```
3. Reset the cursor to the last correctly indexed block if needed:
   ```bash
   bun run scripts/resetCursor.ts --block 6300000
   ```
4. Restart the service

### Rate limiter note

The rate limiter (`src/api/middleware/rateLimit.ts`) is keyed by **API key ID** (not IP), so it cannot be bypassed by rotating proxy addresses. Limits are FREE = 60 req/min, PREMIUM = 3 000 req/min.

The default store (`InMemoryRateLimitStore`) lives in process memory and resets on restart. It is **not shared across multiple instances**. To scale horizontally, implement `RedisRateLimitStore` (the `RateLimitStore` interface is already defined) using `INCR` + `PEXPIRE`, and pass it to `apiKeyRateLimit(redisStore)` in `server.ts`.
