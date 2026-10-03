#!/usr/bin/env bash
# Runs the real-database tests (*.db.test.ts) against a throwaway local Postgres that is deleted afterwards.
# Never touches any other database: DATABASE_URL is set here, to the temporary instance only.
set -euo pipefail

DIR="$(mktemp -d)"
PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"

cleanup() {
  pg_ctl -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

initdb -D "$DIR/data" -U test --auth=trust >/dev/null
pg_ctl -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/postgres.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$PORT" -U test medialane_test

export DATABASE_URL="postgresql://test@127.0.0.1:$PORT/medialane_test"
export TEST_DATABASE_URL="$DATABASE_URL"
export IO_CLIENT_ID="client_IO_TEST"

bunx prisma db push --skip-generate --accept-data-loss >/dev/null
bun test $(find src -name '*.db.test.ts')
