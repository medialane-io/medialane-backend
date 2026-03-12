/**
 * pre-migrate.ts — runs before `prisma migrate deploy` on every Railway startup.
 *
 * 1. Marks migration 20260312000002_normalize_collection_addresses as applied
 *    if it is in a FAILED (finished_at IS NULL) state or not recorded, so
 *    `prisma migrate deploy` can proceed past it.
 *
 * 2. Directly removes duplicate short-address Collection rows so the
 *    collections page stops showing duplicates.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ── 1. Fix stuck migration ────────────────────────────────────────────────
  const STUCK = "20260312000002_normalize_collection_addresses";

  // Update the row if it exists but hasn't finished (failed state)
  await prisma.$executeRawUnsafe(`
    UPDATE "_prisma_migrations"
    SET finished_at = NOW(), logs = NULL, applied_steps_count = 1
    WHERE migration_name = '${STUCK}'
      AND finished_at IS NULL
      AND rolled_back_at IS NULL
  `);

  // Insert a synthetic "applied" row if it was never recorded at all
  await prisma.$executeRawUnsafe(`
    INSERT INTO "_prisma_migrations"
      (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count)
    SELECT
      gen_random_uuid()::text,
      'pre-migrate-synthetic',
      NOW(),
      '${STUCK}',
      NULL,
      NOW(),
      1
    WHERE NOT EXISTS (
      SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '${STUCK}'
    )
  `);

  console.log(`[pre-migrate] Migration ${STUCK} marked as applied.`);

  // ── 2. Re-point Token rows referencing short-address collections ──────────
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

  // ── 3. Delete duplicate short-address Collection rows ────────────────────
  const { count } = await prisma.$executeRaw`
    DELETE FROM "Collection"
    WHERE length(substring("contractAddress" FROM 3)) < 64
      AND EXISTS (
        SELECT 1 FROM "Collection" c2
        WHERE c2.chain = "Collection".chain
          AND c2."contractAddress" = '0x' || lpad(substring("Collection"."contractAddress" FROM 3), 64, '0')
      )
  `;

  console.log(`[pre-migrate] Removed ${count ?? "?"} duplicate short-address collection(s).`);

  // ── 4. Normalize any remaining short-address collections ─────────────────
  await prisma.$executeRaw`
    UPDATE "Collection"
    SET "contractAddress" = '0x' || lpad(substring("contractAddress" FROM 3), 64, '0')
    WHERE length(substring("contractAddress" FROM 3)) < 64
  `;

  await prisma.$executeRaw`
    UPDATE "Collection"
    SET "owner" = '0x' || lpad(substring("owner" FROM 3), 64, '0')
    WHERE "owner" IS NOT NULL
      AND length(substring("owner" FROM 3)) < 64
  `;

  console.log("[pre-migrate] Done.");
}

main()
  .catch((e) => {
    console.error("[pre-migrate] Error (non-fatal):", e);
  })
  .finally(() => prisma.$disconnect());
