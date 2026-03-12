/**
 * pre-migrate.ts — runs before `prisma migrate deploy` on every Railway startup.
 * Directly applies any DB changes that are stuck in failed migrations.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function markApplied(name: string) {
  await prisma.$executeRawUnsafe(`
    UPDATE "_prisma_migrations"
    SET finished_at = NOW(), logs = NULL, applied_steps_count = 1
    WHERE migration_name = '${name}'
      AND finished_at IS NULL
      AND rolled_back_at IS NULL
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "_prisma_migrations"
      (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count)
    SELECT gen_random_uuid()::text, 'pre-migrate-synthetic', NOW(), '${name}', NULL, NOW(), 1
    WHERE NOT EXISTS (
      SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '${name}'
    )
  `);
  console.log(`[pre-migrate] ${name} marked as applied.`);
}

async function main() {
  // ── 1. FTS indexes — CREATE INDEX CONCURRENTLY cannot run inside a Prisma
  //    migration transaction, so the migration always failed. Create them here
  //    without CONCURRENTLY (safe, just briefly locks the table). ─────────────
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS idx_token_fts ON "Token" USING GIN (
      to_tsvector('english',
        coalesce(name, '') || ' ' || coalesce(description, '') || ' ' ||
        "contractAddress" || ' ' || "tokenId"
      )
    )
  `;
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS idx_collection_fts ON "Collection" USING GIN (
      to_tsvector('english', coalesce(name, '') || ' ' || "contractAddress")
    )
  `;
  await markApplied("20260312000000_add_fts_indexes");

  // ── 2. Add missing Job/WebhookDelivery columns from migration 00001 ───────
  await prisma.$executeRaw`ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "reaperAttempts" INTEGER NOT NULL DEFAULT 0`;
  await prisma.$executeRaw`ALTER TABLE "WebhookDelivery" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0`;
  await prisma.$executeRaw`ALTER TABLE "WebhookDelivery" ADD COLUMN IF NOT EXISTS "isTerminal" BOOLEAN NOT NULL DEFAULT false`;
  await markApplied("20260312000001_add_job_reaper_and_delivery_tracking");

  // ── 3. Mark 00002 as applied (its UPDATE failed on unique constraint;
  //    migration 00003 does the actual cleanup below) ────────────────────────
  await markApplied("20260312000002_normalize_collection_addresses");

  // ── 4. Re-point Token rows referencing short-address collections ──────────
  await prisma.$executeRaw`
    UPDATE "Token"
    SET "contractAddress" = '0x' || lpad(substring("contractAddress" FROM 3), 64, '0')
    WHERE length(substring("contractAddress" FROM 3)) < 64
      AND EXISTS (
        SELECT 1 FROM "Collection" c
        WHERE c.chain = "Token".chain
          AND c."contractAddress" = '0x' || lpad(substring("Token"."contractAddress" FROM 3), 64, '0')
      )
  `;

  // ── 5. Delete duplicate short-address Collection rows ────────────────────
  await prisma.$executeRaw`
    DELETE FROM "Collection"
    WHERE length(substring("contractAddress" FROM 3)) < 64
      AND EXISTS (
        SELECT 1 FROM "Collection" c2
        WHERE c2.chain = "Collection".chain
          AND c2."contractAddress" = '0x' || lpad(substring("Collection"."contractAddress" FROM 3), 64, '0')
      )
  `;

  // ── 6. Normalize any remaining short-address collections / owners ─────────
  await prisma.$executeRaw`
    UPDATE "Collection"
    SET "contractAddress" = '0x' || lpad(substring("contractAddress" FROM 3), 64, '0')
    WHERE length(substring("contractAddress" FROM 3)) < 64
  `;
  await prisma.$executeRaw`
    UPDATE "Collection"
    SET "owner" = '0x' || lpad(substring("owner" FROM 3), 64, '0')
    WHERE "owner" IS NOT NULL AND length(substring("owner" FROM 3)) < 64
  `;

  // ── 7. Mark permanently-failing METADATA_PIN jobs as DONE so the reaper
  //    stops re-queuing them (Pinata free plan doesn't support pin_by_cid) ───
  await prisma.$executeRaw`
    UPDATE "Job" SET status = 'DONE'
    WHERE type = 'METADATA_PIN' AND status IN ('FAILED', 'PENDING')
  `;

  console.log("[pre-migrate] Done.");
}

main()
  .catch((e) => console.error("[pre-migrate] Error (non-fatal):", e))
  .finally(() => prisma.$disconnect());
