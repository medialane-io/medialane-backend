/**
 * One-time patch: update all collections with standard = "UNKNOWN" to "ERC721".
 * Safe to run multiple times — only affects UNKNOWN rows.
 *
 * Run: ~/.bun/bin/bun scripts/patch-unknown-standard.ts
 */
import prisma from "../src/db/client.js";

const result = await prisma.collection.updateMany({
  where: { standard: "UNKNOWN" },
  data: { standard: "ERC721" },
});

console.log(`Updated ${result.count} collection(s) from UNKNOWN → ERC721.`);
await prisma.$disconnect();
