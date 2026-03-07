/**
 * One-time backfill: enqueue COLLECTION_METADATA_FETCH for all existing collections
 * that haven't had their on-chain metadata fetched yet.
 *
 * Run: ~/.bun/bin/bun scripts/backfill-collection-metadata.ts
 */
import prisma from "../src/db/client.js";
import { enqueueJob } from "../src/orchestrator/queue.js";

const collections = await prisma.collection.findMany({
  where: {
    OR: [
      { metadataStatus: "PENDING" },
      { metadataStatus: "FAILED" },
      { name: null },
      { symbol: null },
    ],
  },
  select: { chain: true, contractAddress: true, metadataStatus: true, name: true },
});

console.log(`Enqueuing COLLECTION_METADATA_FETCH for ${collections.length} collection(s)...`);

for (const col of collections) {
  await enqueueJob("COLLECTION_METADATA_FETCH", {
    chain: col.chain,
    contractAddress: col.contractAddress,
  });
  console.log(`  ✓ ${col.contractAddress} (status: ${col.metadataStatus}, name: ${col.name ?? "null"})`);
}

console.log("Done. Jobs will be processed by the orchestrator.");
await prisma.$disconnect();
