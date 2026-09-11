import prisma from "../src/db/client.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

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

console.log(`Will EXPIRE (ACTIVE, w/ fills): ${activeWithFills}  (keeps OrderFill provenance)`);

if (activeOnNew > 0) {
  console.log("\nRefusing: ACTIVE orders exist on the NEW venues. Investigate before purging.");
  await prisma.$disconnect();
  process.exit(1);
}
if (activeTotal === 0) {
  console.log("\nNothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}
if (DRY_RUN) {
  console.log("\nDRY_RUN=true - re-run with DRY_RUN=false to execute.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\nDeleting stale ACTIVE orders (no fills)...");
const { count: deleted } = await prisma.order.deleteMany({
  where: { status: "ACTIVE", fills: { none: {} } },
});
console.log("Expiring stale ACTIVE orders that carry fill history...");
const { count: expired } = await prisma.order.updateMany({
  where: { status: "ACTIVE", fills: { some: {} } },
  data: { status: "EXPIRED" },
});
const remaining = await prisma.order.count();
const stillActive = await prisma.order.count({ where: { status: "ACTIVE" } });
console.log(`\nDeleted ${deleted} stale active orders; expired ${expired} partially-filled ones`);
console.log(`  Orders remaining (history): ${remaining}  |  still ACTIVE: ${stillActive}`);

await prisma.$disconnect();
