/**
 * One-time, idempotent backfill: derive Order.marketplaceService from
 * Order.marketplaceContract. Safe to re-run. --dry-run to preview.
 * (Collection.service backfill removed — legacy Collection.source dropped.)
 *
 * Run: bun run backfill-service-id [--dry-run]
 *
 * Phase 2A.3 of the service-model refactor
 * (docs/superpowers/plans/2026-05-16-service-model-refactor.md).
 */
import prisma from "../db/client.js";
import { normalizeAddress } from "../utils/starknet.js";
import {
  MARKETPLACE_721_CONTRACT,
  MARKETPLACE_1155_CONTRACT,
} from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backfill-service-id");
const DRY = process.argv.includes("--dry-run");

async function backfillOrders() {
  // Build the map defensively — skip any constant that is somehow unset so a
  // missing env value can never produce a normalizeAddress(undefined) throw.
  const MARKETPLACE_TO_SERVICE: Record<string, string> = {};
  if (MARKETPLACE_721_CONTRACT) {
    MARKETPLACE_TO_SERVICE[normalizeAddress(MARKETPLACE_721_CONTRACT)] =
      "medialane-marketplace-erc721";
  }
  if (MARKETPLACE_1155_CONTRACT) {
    MARKETPLACE_TO_SERVICE[normalizeAddress(MARKETPLACE_1155_CONTRACT)] =
      "medialane-marketplace-erc1155";
  }
  const rows = await prisma.order.findMany({
    where: { marketplaceService: null, marketplaceContract: { not: null } },
    select: { id: true, marketplaceContract: true },
  });
  let updated = 0;
  for (const r of rows) {
    const key = normalizeAddress(r.marketplaceContract as string);
    const svc = MARKETPLACE_TO_SERVICE[key];
    if (!svc) {
      log.warn(
        { id: r.id, marketplaceContract: r.marketplaceContract },
        "unknown marketplace — skipping",
      );
      continue;
    }
    log.info({ id: r.id, svc }, DRY ? "[dry] would set" : "set");
    if (!DRY) {
      await prisma.order.update({
        where: { id: r.id },
        data: { marketplaceService: svc },
      });
    }
    updated++;
  }
  return { scanned: rows.length, updated };
}

async function main() {
  log.info({ dryRun: DRY }, "backfill-service-id start");
  const o = await backfillOrders();
  log.info({ orders: o }, "backfill-service-id done");
  await prisma.$disconnect();
}

// Explicit exit codes: this runs in the Railway start chain BEFORE
// `bun run src/index.ts` (railway.json). A lingering handle must never
// stall the chain and keep the server from booting — always terminate.
main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    log.error({ err: e }, "backfill failed");
    await prisma.$disconnect();
    process.exit(1);
  });
