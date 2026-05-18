/**
 * One-shot cleanup: delete ACTIVE orders created before the contract-upgrade
 * cutoff (stale orders that can never be fulfilled on the new contracts).
 * DRY_RUN by default — re-run with DRY_RUN=false to execute.
 *
 * Run: bun run scripts/purge-old-orders.ts   (preview)
 *      DRY_RUN=false bun run scripts/purge-old-orders.ts   (execute)
 */
import prisma from "../src/db/client.js";

const CUTOFF = new Date("2026-04-26T21:03:34.000Z");
const DRY_RUN = process.env.DRY_RUN !== "false";

const grouped = await prisma.order.groupBy({
  by: ["status"],
  where: { createdAt: { lt: CUTOFF } },
  _count: { _all: true },
  orderBy: { status: "asc" },
});
const activeCount = await prisma.order.count({
  where: { status: "ACTIVE", createdAt: { lt: CUTOFF } },
});
const total = await prisma.order.count({ where: { createdAt: { lt: CUTOFF } } });

console.log(`\n── Orders before contract upgrade (${CUTOFF.toISOString()}) ──`);
for (const row of grouped) console.log(`  ${row.status}: ${row._count._all}`);
console.log(`\nTotal before cutoff  : ${total}`);
console.log(`Will DELETE (ACTIVE) : ${activeCount}`);
console.log(`Will KEEP  (rest)    : ${total - activeCount}`);

if (activeCount === 0) {
  console.log("\nNothing to delete.");
  await prisma.$disconnect();
  process.exit(0);
}

if (DRY_RUN) {
  console.log("\n⚠  DRY_RUN=true  — re-run with DRY_RUN=false to execute.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\nDeleting...");
const { count } = await prisma.order.deleteMany({
  where: { status: "ACTIVE", createdAt: { lt: CUTOFF } },
});
const remaining = await prisma.order.count();
console.log(`\n✓ Deleted ${count} active orders`);
console.log(`  Orders remaining: ${remaining}`);

await prisma.$disconnect();
