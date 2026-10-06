import { num } from "starknet";
import prisma from "../db/client.js";
import { pollContractEvents, getLatestBlock } from "../mirror/poller.js";
import { parseEvents } from "../mirror/parser.js";
import { dispatchTransfer } from "../mirror/handlers/transfer.js";
import { TRANSFER_SELECTOR, TRANSFER_SINGLE_SELECTOR, TRANSFER_BATCH_SELECTOR } from "../config/constants.js";
import { normalizeAddress } from "../utils/starknet.js";
import { handleStatsUpdate } from "../orchestrator/stats.js";
import { handleCollectionMetadataFetch } from "../orchestrator/collectionMetadata.js";

const [address, from, to] = process.argv.slice(2);
if (!address || !from) {
  console.error("usage: backfill-collection.ts <contractAddress> <fromBlock> [toBlock]");
  process.exit(1);
}

const contractAddress = normalizeAddress("STARKNET", address);
const fromBlock = Number(from);
const toBlock = to ? Number(to) : await getLatestBlock();

const collection = await prisma.collection.findUnique({
  where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  select: { id: true },
});
if (!collection) {
  console.warn(`backfill: ${contractAddress} is not in the Collection table — skipping`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`backfill: ${contractAddress} blocks ${fromBlock}..${toBlock}`);
const raw = await pollContractEvents({
  address: contractAddress,
  fromBlock,
  toBlock,
  keys: [[num.toHex(TRANSFER_SELECTOR), num.toHex(TRANSFER_SINGLE_SELECTOR), num.toHex(TRANSFER_BATCH_SELECTOR)]],
});
const events = parseEvents(raw).filter(
  (e) => e.type === "Transfer" || e.type === "TransferSingle" || e.type === "TransferBatch",
);

let applied = 0;
let skipped = 0;
for (const event of events) {
  try {
    await prisma.$transaction((tx) => dispatchTransfer(event, tx, "STARKNET"));
    applied++;
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") console.warn("backfill row error:", err);
    skipped++;
  }
}

console.log(`backfill done: rawEvents=${raw.length} applied=${applied} skipped=${skipped}`);

const target = { chain: "STARKNET", contractAddress };
for (const [label, run] of [
  ["stats", () => handleStatsUpdate(target)],
  ["collection metadata", () => handleCollectionMetadataFetch(target)],
  ["stats", () => handleStatsUpdate(target)],
] as const) {
  try {
    await run();
    console.log(`backfill: ${label} ok`);
  } catch (err) {
    console.warn(`backfill: ${label} failed`, err);
  }
}
await prisma.$disconnect();
process.exit(0);
