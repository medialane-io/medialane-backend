/**
 * CLI wrapper — the engine lives in src/rewards/compute.ts (also run by the
 * orchestrator's scheduled loop and the admin endpoint).
 *
 * Usage: bun run src/scripts/compute-rewards.ts [--dry-run] [--no-badges]
 */

import prisma from "../db/client.js";
import { computeRewards } from "../rewards/compute.js";

const summary = await computeRewards({
  dryRun: process.argv.includes("--dry-run"),
  skipBadges: process.argv.includes("--no-badges"),
});

console.log(
  `Computed ${summary.addresses} addresses, ${summary.events} events, ${summary.badgeGrants} badge grants${summary.dryRun ? " (DRY RUN — no writes)" : ""}`
);
console.log("\nTop 10 scores:");
for (const t of summary.top10) {
  console.log(`  ${t.address.slice(0, 10)}…  ${t.totalXp} XP  level ${t.level}`);
}

await prisma.$disconnect();
