/**
 * pre-migrate.ts — runs before `prisma migrate deploy` on every Railway startup.
 *
 * Directly applies any DB changes that are stuck in failed migrations,
 * so `prisma migrate deploy` can proceed cleanly.
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
  // ── 1. Add missing columns from migration 20260312000001 ─────────────────
  // These columns were added to the Prisma schema but the migration SQL never
  // ran in production, causing every job.create / job.findFirst to fail.
  await prisma.$executeRaw`ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "reaperAttempts" INTEGER NOT NULL DEFAULT 0`;
  await prisma.$executeRaw`ALTER TABLE "WebhookDelivery" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0`;
  await prisma.$executeRaw`ALTER TABLE "WebhookDelivery" ADD COLUMN IF NOT EXISTS "isTerminal" BOOLEAN NOT NULL DEFAULT false`;
  console.log("[pre-migrate] Job/WebhookDelivery columns ensured.");

  await markApplied("20260312000001_add_job_reaper_and_delivery_tracking");

  // ── 2. Mark 20260312000002 as applied (its UPDATE failed on unique constraint;
  //    migration 20260312000003 does the actual cleanup below) ───────────────
  await markApplied("20260312000002_normalize_collection_addresses");

  // ── 3. Re-point Token rows referencing short-address collections ──────────
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

  // ── 4. Delete duplicate short-address Collection rows ────────────────────
  await prisma.$executeRaw`
    DELETE FROM "Collection"
    WHERE length(substring("contractAddress" FROM 3)) < 64
      AND EXISTS (
        SELECT 1 FROM "Collection" c2
        WHERE c2.chain = "Collection".chain
          AND c2."contractAddress" = '0x' || lpad(substring("Collection"."contractAddress" FROM 3), 64, '0')
      )
  `;

  // ── 5. Normalize any remaining short-address collections / owners ─────────
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

  console.log("[pre-migrate] Done.");
}

main()
  .catch((e) => console.error("[pre-migrate] Error (non-fatal):", e))
  .finally(() => prisma.$disconnect());
