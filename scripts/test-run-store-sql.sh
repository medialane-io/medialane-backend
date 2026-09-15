#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="$(mktemp -d)"
PORT=$((20000 + RANDOM % 20000))
URL="postgresql://postgres@127.0.0.1:${PORT}/run_store_test"

cleanup() {
  pg_ctl -D "$DATA_DIR" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

initdb -D "$DATA_DIR" -U postgres --auth=trust >/dev/null
pg_ctl -D "$DATA_DIR" -o "-p ${PORT} -k ${DATA_DIR} -h 127.0.0.1" -l "$DATA_DIR/postgres.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$PORT" -U postgres run_store_test

DATABASE_URL="$URL" bunx prisma db push --skip-generate >/dev/null
DATABASE_URL="$URL" RUN_STORE_TEST_DATABASE_URL="$URL" bun test src/launchpad/run-store.sql.test.ts
