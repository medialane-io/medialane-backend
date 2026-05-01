import postgres from "postgres";

const CUTOFF = "2026-04-26T21:03:34.000Z";
const DRY_RUN = process.env.DRY_RUN !== "false";

const sql = postgres(process.env.DATABASE_URL!);

const counts = await sql`
  SELECT status, COUNT(*)::int AS n
  FROM "Order"
  WHERE "createdAt" < ${CUTOFF}::timestamptz
  GROUP BY status
  ORDER BY status
`;

const [[{ n: activeCount }]] = await sql`
  SELECT COUNT(*)::int AS n FROM "Order"
  WHERE status = 'ACTIVE' AND "createdAt" < ${CUTOFF}::timestamptz
`;

const [[{ n: total }]] = await sql`
  SELECT COUNT(*)::int AS n FROM "Order" WHERE "createdAt" < ${CUTOFF}::timestamptz
`;

console.log(`\n── Orders before contract upgrade (${CUTOFF}) ──`);
for (const row of counts) console.log(`  ${row.status}: ${row.n}`);
console.log(`\nTotal before cutoff  : ${total}`);
console.log(`Will DELETE (ACTIVE) : ${activeCount}`);
console.log(`Will KEEP  (rest)    : ${total - activeCount}`);

if (activeCount === 0) { console.log("\nNothing to delete."); await sql.end(); process.exit(0); }

if (DRY_RUN) {
  console.log("\n⚠  DRY_RUN=true  — re-run with DRY_RUN=false to execute.");
  await sql.end(); process.exit(0);
}

console.log("\nDeleting...");
const result = await sql`
  DELETE FROM "Order"
  WHERE status = 'ACTIVE' AND "createdAt" < ${CUTOFF}::timestamptz
`;

const [[{ n: remaining }]] = await sql`SELECT COUNT(*)::int AS n FROM "Order"`;
console.log(`\n✓ Deleted ${result.count} active orders`);
console.log(`  Orders remaining: ${remaining}`);

await sql.end();
