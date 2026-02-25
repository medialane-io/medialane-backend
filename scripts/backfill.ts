#!/usr/bin/env bun
/**
 * One-shot historical backfill using Voyager API.
 * Usage: bun run scripts/backfill.ts [--from <block>] [--to <block>]
 */

import { pollEvents, pollTransferEvents } from "../src/mirror/poller.js";
import { parseEvents } from "../src/mirror/parser.js";
import { handleOrderCreated } from "../src/mirror/handlers/orderCreated.js";
import { handleOrderFulfilled } from "../src/mirror/handlers/orderFulfilled.js";
import { handleOrderCancelled } from "../src/mirror/handlers/orderCancelled.js";
import { handleTransfer } from "../src/mirror/handlers/transfer.js";
import { saveCursor } from "../src/mirror/cursor.js";
import { enqueueJob } from "../src/orchestrator/queue.js";
import prisma from "../src/db/client.js";
import { env } from "../src/config/env.js";
import { createLogger } from "../src/utils/logger.js";

const log = createLogger("backfill");

const args = process.argv.slice(2);
const fromArg = args.indexOf("--from");
const toArg = args.indexOf("--to");

const fromBlock = fromArg >= 0 ? Number(args[fromArg + 1]) : env.INDEXER_START_BLOCK;
const toBlock = toArg >= 0 ? Number(args[toArg + 1]) : await getLatestBlock();

async function getLatestBlock(): Promise<number> {
  const { createProvider } = await import("../src/utils/starknet.js");
  const provider = createProvider();
  const block = await provider.getBlockWithTxHashes("latest");
  return (block as any).block_number as number;
}

async function backfill() {
  log.info({ fromBlock, toBlock }, "Starting backfill");
  const BATCH_SIZE = 500;

  for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, toBlock);
    log.info({ start, end, progress: `${start - fromBlock}/${toBlock - fromBlock}` }, "Backfilling batch");

    try {
      const rawEvents = await pollEvents(start, end);
      const parsedEvents = parseEvents(rawEvents);

      await prisma.$transaction(
        async (tx) => {
          for (const event of parsedEvents) {
            switch (event.type) {
              case "OrderCreated":
                await handleOrderCreated(event, tx as any);
                break;
              case "OrderFulfilled":
                await handleOrderFulfilled(event, tx as any);
                break;
              case "OrderCancelled":
                await handleOrderCancelled(event, tx as any);
                break;
              case "Transfer":
                await handleTransfer(event, tx as any);
                break;
            }
          }
          await saveCursor({ lastBlock: BigInt(end), continuationToken: null });
        },
        { timeout: 60000 }
      );

      // Enqueue metadata jobs for new tokens
      const pendingTokens = await prisma.token.findMany({
        where: { metadataStatus: "PENDING", tokenUri: null },
        select: { contractAddress: true, tokenId: true },
        take: 100,
      });

      for (const t of pendingTokens) {
        await enqueueJob("METADATA_FETCH", t);
      }

      log.info({ start, end, events: parsedEvents.length }, "Batch complete");
    } catch (err) {
      log.error({ err, start, end }, "Batch failed");
    }
  }

  log.info("Backfill complete");
  await prisma.$disconnect();
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
