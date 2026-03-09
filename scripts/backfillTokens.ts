#!/usr/bin/env bun
/**
 * Targeted token backfill — re-indexes Transfer (mint) events for all known
 * NFT collection contracts from each collection's startBlock to the latest block.
 *
 * Use this to recover assets that were minted before the indexer bug fix that
 * caused Transfer events from individual NFT contracts to be ignored.
 *
 * Usage:
 *   bun run scripts/backfillTokens.ts
 *   bun run scripts/backfillTokens.ts --contract 0xabc...   # single collection
 */

import { pollTransferEvents } from "../src/mirror/poller.js";
import { parseEvents } from "../src/mirror/parser.js";
import { handleTransfer } from "../src/mirror/handlers/transfer.js";
import { enqueueJob } from "../src/orchestrator/queue.js";
import prisma from "../src/db/client.js";
import { createLogger } from "../src/utils/logger.js";

const log = createLogger("backfill-tokens");
const CHAIN = "STARKNET" as const;
const BATCH_SIZE = 500;

const args = process.argv.slice(2);
const contractArg = args.indexOf("--contract");
const targetContract = contractArg >= 0 ? args[contractArg + 1] : null;

async function getLatestBlock(): Promise<number> {
  const { createProvider } = await import("../src/utils/starknet.js");
  const provider = createProvider();
  const block = await provider.getBlockWithTxHashes("latest");
  return (block as any).block_number as number;
}

async function backfillCollection(contractAddress: string, startBlock: bigint, toBlock: number) {
  const from = Number(startBlock);
  log.info({ contractAddress, from, to: toBlock }, "Backfilling token transfers");

  let totalTransfers = 0;

  for (let start = from; start <= toBlock; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, toBlock);

    try {
      const rawEvents = await pollTransferEvents(contractAddress, start, end);
      if (!rawEvents.length) continue;

      const parsedEvents = parseEvents(rawEvents);
      const transfers = parsedEvents.filter((e) => e.type === "Transfer");
      if (!transfers.length) continue;

      await prisma.$transaction(
        async (tx) => {
          for (const event of transfers) {
            if (event.type !== "Transfer") continue;
            await handleTransfer(event, tx as any, CHAIN);
          }
        },
        { timeout: 30000 }
      );

      totalTransfers += transfers.length;
      log.info({ contractAddress, start, end, transfers: transfers.length }, "Batch complete");
    } catch (err) {
      log.error({ err, contractAddress, start, end }, "Batch failed — skipping");
    }
  }

  return totalTransfers;
}

async function run() {
  const toBlock = await getLatestBlock();
  log.info({ toBlock }, "Starting token backfill");

  const collections = await prisma.collection.findMany({
    where: {
      chain: CHAIN,
      ...(targetContract ? { contractAddress: targetContract } : {}),
    },
    select: { contractAddress: true, startBlock: true, name: true },
  });

  if (collections.length === 0) {
    log.warn("No collections found — nothing to backfill");
    await prisma.$disconnect();
    return;
  }

  log.info({ count: collections.length }, "Collections to backfill");

  let totalNewTokens = 0;

  for (const col of collections) {
    const transfers = await backfillCollection(col.contractAddress, col.startBlock, toBlock);
    totalNewTokens += transfers;
    log.info({ contractAddress: col.contractAddress, name: col.name, transfers }, "Collection done");
  }

  // Enqueue METADATA_FETCH for all tokens that are still PENDING after backfill
  const pendingTokens = await prisma.token.findMany({
    where: { chain: CHAIN, metadataStatus: "PENDING", tokenUri: null },
    select: { contractAddress: true, tokenId: true },
  });

  log.info({ count: pendingTokens.length }, "Enqueueing metadata fetch jobs");
  for (const token of pendingTokens) {
    await enqueueJob("METADATA_FETCH", { chain: CHAIN, contractAddress: token.contractAddress, tokenId: token.tokenId });
  }

  log.info({ totalNewTokens, metadataJobs: pendingTokens.length }, "Token backfill complete");
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
