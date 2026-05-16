/**
 * One-time, idempotent backfill: derive Collection.service from legacy
 * Collection.source, and Order.marketplaceService from Order.marketplaceContract.
 * Leaves legacy columns untouched. Safe to re-run. --dry-run to preview.
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

// Legacy source -> canonical long-form service ID (01-core-model §III).
// null = no Medialane service (external).
const SOURCE_TO_SERVICE: Record<string, string | null> = {
  MEDIALANE_ERC721: "mip-erc721",
  MEDIALANE_REGISTRY: "mip-erc721", // legacy alias of the ERC-721 registry
  MEDIALANE_ERC1155: "mip-erc1155",
  ERC1155_FACTORY: "mip-erc1155", // legacy alias
  POP_PROTOCOL: "pop-protocol",
  COLLECTION_DROP: "drop-collection",
  EXTERNAL: null,
  EXTERNAL_ERC721: null,
  EXTERNAL_ERC1155: null,
  PARTNERSHIP: null,
  IP_TICKET: null,
  IP_CLUB: null,
  GAME: null,
};

async function backfillCollections() {
  const rows = await prisma.collection.findMany({
    where: { service: null },
    select: { id: true, source: true },
  });
  let updated = 0;
  for (const r of rows) {
    if (!(r.source in SOURCE_TO_SERVICE)) {
      log.warn({ id: r.id, source: r.source }, "unmapped source — skipping");
      continue;
    }
    const service = SOURCE_TO_SERVICE[r.source];
    if (service === null) continue; // external: leave service null
    log.info({ id: r.id, source: r.source, service }, DRY ? "[dry] would set" : "set");
    if (!DRY) {
      await prisma.collection.update({ where: { id: r.id }, data: { service } });
    }
    updated++;
  }
  return { scanned: rows.length, updated };
}

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
  const c = await backfillCollections();
  const o = await backfillOrders();
  log.info({ collections: c, orders: o }, "backfill-service-id done");
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
