import prisma from "../src/db/client.js";
import { worker } from "../src/orchestrator/worker.js";

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
  worker.enqueue({
    type: "COLLECTION_METADATA_FETCH",
    chain: col.chain,
    contractAddress: col.contractAddress,
  });
  console.log(`  ✓ ${col.contractAddress} (status: ${col.metadataStatus}, name: ${col.name ?? "null"})`);
}

console.log("Done. Jobs will be processed by the orchestrator.");
await prisma.$disconnect();
