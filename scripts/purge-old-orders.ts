/**
 * One-shot cutover cleanup (marketplace protocol redesign, 2026-05-31):
 * delete ACTIVE orders/offers that are stranded on the OLD marketplace contracts
 * — they can never be fulfilled on the redesigned venues. Provenance is kept:
 *   - FULFILLED / CANCELLED / EXPIRED orders are untouched (history).
 *   - ACTIVE orders that already have a fill (partially-filled 1155 listings) are
 *     KEPT too — their OrderFill rows are real history.
 * So we only delete ACTIVE orders with zero fills (pure stale listings/offers).
 *
 * DRY_RUN by default. Run:
 *   bun run scripts/purge-old-orders.ts                  (preview)
 *   DRY_RUN=false bun run scripts/purge-old-orders.ts    (execute)
 */
import prisma from "../src/db/client.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// Redesigned venues (deployed 2026-05-31). Orders on these must NEVER be purged.
const NEW_VENUES = [
  "0x069cf5391077e3ebdd9cb6aebf90ed530d29f0d6aa34a43f5afae938c0fb565e",
  "0x040cd7b3e73bb3c892166e34bdc01d1797f97ecbc356c23f1cf38033cacf0077",
];

const grouped = await prisma.order.groupBy({
  by: ["status"],
  _count: { _all: true },
  orderBy: { status: "asc" },
});
const activeTotal = await prisma.order.count({ where: { status: "ACTIVE" } });
const activeWithFills = await prisma.order.count({
  where: { status: "ACTIVE", fills: { some: {} } },
});
// Safety guard: nothing ACTIVE should be on the new venues yet. If it is, abort —
// the predicate would otherwise nuke live orders.
const activeOnNew = await prisma.order.count({
  where: { status: "ACTIVE", marketplaceContract: { in: NEW_VENUES } },
});
const toDelete = await prisma.order.count({
  where: { status: "ACTIVE", fills: { none: {} } },
});

console.log("\n── Orders by status (all time) ──");
for (const row of grouped) console.log(`  ${row.status}: ${row._count._all}`);
console.log(`\nACTIVE total                 : ${activeTotal}`);
console.log(`  ...with fills (KEEP, history): ${activeWithFills}`);
console.log(`  ...on NEW venues (must be 0) : ${activeOnNew}`);
console.log(`Will DELETE (ACTIVE, no fills): ${toDelete}`);
console.log(`Will KEEP                     : all history (FULFILLED/CANCELLED/EXPIRED + any order with fills)`);

if (activeOnNew > 0) {
  console.log("\nRefusing: ACTIVE orders exist on the NEW venues. Investigate before purging.");
  await prisma.$disconnect();
  process.exit(1);
}
if (toDelete === 0) {
  console.log("\nNothing to delete.");
  await prisma.$disconnect();
  process.exit(0);
}
if (DRY_RUN) {
  console.log("\nDRY_RUN=true - re-run with DRY_RUN=false to execute.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\nDeleting stale ACTIVE orders (no fills)...");
const { count } = await prisma.order.deleteMany({
  where: { status: "ACTIVE", fills: { none: {} } },
});
const remaining = await prisma.order.count();
console.log(`\nDeleted ${count} stale active orders`);
console.log(`  Orders remaining (history): ${remaining}`);

await prisma.$disconnect();
