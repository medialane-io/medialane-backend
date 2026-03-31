## Medialane Backend – Local Dev DB & Mock Data

### Security audit note (passkey vs PIN)
The wallet security logic for passkey/PIN transfers and session activation was updated in `medialane-io/security-audit/README.md`.

No Prisma schema changes were made for this feature, so the existing `db-mock` workflow remains valid. For manual QA, you should still run:
- `npm run db:start`
- `npm run db:seed`

This folder contains everything you need to spin up a **local Postgres** for development and seed it with **realistic mock data**.

You’ll use two npm scripts from the `medialane-backend` project:

- `npm run db:start` – start the local Postgres in Docker
- `npm run db:seed` – apply the Prisma schema and seed mock data

---

### 1. Prerequisites

- **Docker** (Docker Desktop on macOS is fine), and it must be **running**.
- **Bun** installed (the backend already uses it):
  - If you don’t have it:  
    ```bash
    curl -fsSL https://bun.sh/install | bash
    exec /bin/zsh
    bun --version
    ```
- **Node + npm** installed (you’re already using them).

---

### 2. Ensure your `.env` points to the dev DB

In `medialane-backend/.env`, set `DATABASE_URL` to match the Docker Postgres config from `db-mock/docker-compose.dev.yml`:

```env
DATABASE_URL="postgresql://medialane:medialane@localhost:5432/medialane_dev?schema=public"
```

Save the file.

> Tip: when you later run `npm run db:seed`, the seed script will log  
> `Using DATABASE_URL: ...` so you can copy/paste the exact URL if needed.

---

### 3. Install backend dependencies (once)

From the backend root:

```bash
cd /Users/yrandanova/Documents/medialane/medialane-backend
npm install
```

This will also run `bunx prisma generate` (via `postinstall`) and generate the Prisma client.

---

### 4. Start the development database

From `medialane-backend`:

```bash
npm run db:start
```

What this does:

- Runs `docker compose -f db-mock/docker-compose.dev.yml up -d`
- Starts a Postgres 16 container with:
  - user: `medialane`
  - password: `medialane`
  - database: `medialane_dev`
  - port: `5432` on your local machine

You can run `npm run db:start` again safely; Docker will just ensure the container is up.

---

### 5. Apply schema and seed mock data

Still in `medialane-backend`:

```bash
npm run db:seed
```

This runs:

1. `bunx prisma db push` – applies the Prisma schema from `prisma/schema.prisma` to the dev database (no migrations required for local).
2. `node db-mock/seed.cjs` – loads all JSON files under `db-mock/mock/*.json` and **upserts** them via Prisma.

Properties:

- **Idempotent**: because it uses `upsert` on unique keys, you can run `npm run db:seed` as many times as you like without duplicating rows.
- **Relationally consistent**: mock data is wired so foreign keys (e.g. `tenantId`, `endpointId`, `chain/contractAddress/tokenId`) line up.

---

### 6. Run the backend against the dev DB

Once `db:start` and `db:seed` have completed successfully, start the backend:

```bash
npm run dev
```

You should see logs like:

```text
Starting Medialane Backend
Database connected
HTTP server listening ... port: 3000
```

At this point:

- The backend is reading from your **Docker Postgres** with **mock data**.
- You can point the frontend/dapp at `http://localhost:3000` and use the API for local development.

---

### 7. Stopping / cleaning up

- To stop the backend dev server: hit `Ctrl + C` in the terminal running `npm run dev`.
- To stop the Docker Postgres:

  ```bash
  docker compose -f db-mock/docker-compose.dev.yml down
  ```

- To wipe Postgres data and start fresh:
  - Stop containers (`docker compose ... down`).
  - Remove the Docker volume if you want a clean DB:

    ```bash
    docker volume rm db-mock_medialane_postgres_data
    ```

  - Then rerun `npm run db:start` and `npm run db:seed`.

