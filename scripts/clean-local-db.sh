#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load DATABASE_URL from .env if present
if [ -f "$ROOT_DIR/.env" ]; then
  export $(grep -v '^#' "$ROOT_DIR/.env" | grep DATABASE_URL | xargs)
fi

PSQL="/opt/homebrew/Cellar/postgresql@16/16.13/bin/psql"
DB_URL="${DATABASE_URL:-postgresql://localhost/medialane}"

echo "🧹 Cleaning local Medialane database..."
echo "   DB: $DB_URL"
echo ""

$PSQL "$DB_URL" <<'SQL'
-- Drop tables that no longer exist in the schema (if still present from old migrations)
DROP TABLE IF EXISTS "Job" CASCADE;
DROP TABLE IF EXISTS "MetadataCache" CASCADE;
DROP TABLE IF EXISTS "UsageLog" CASCADE;
DROP TABLE IF EXISTS "AuditLog" CASCADE;
DROP TYPE IF EXISTS "JobType";
DROP TYPE IF EXISTS "JobStatus";
ALTER TABLE "WebhookDelivery" DROP COLUMN IF EXISTS "jobId";
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "monthlyRequestCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "monthlyResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Truncate bounded tables to start fresh
TRUNCATE TABLE "Transfer" CASCADE;
TRUNCATE TABLE "WebhookDelivery" CASCADE;
TRUNCATE TABLE "TransactionIntent" CASCADE;

-- Show remaining table sizes
SELECT
  relname AS table,
  n_live_tup AS rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
SQL

echo ""
echo "✅ Local database cleaned."
