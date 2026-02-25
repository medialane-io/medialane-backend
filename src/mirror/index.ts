import { loadCursor, saveCursor } from "./cursor.js";
import { pollEvents, getLatestBlock } from "./poller.js";
import { parseEvents } from "./parser.js";
import { handleOrderCreated } from "./handlers/orderCreated.js";
import { handleOrderFulfilled } from "./handlers/orderFulfilled.js";
import { handleOrderCancelled } from "./handlers/orderCancelled.js";
import { handleTransfer } from "./handlers/transfer.js";
import { enqueueJob } from "../orchestrator/queue.js";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mirror");

export async function startMirror(): Promise<void> {
  log.info("Mirror starting...");
  while (true) {
    try {
      await tick();
    } catch (err) {
      log.error({ err }, "Mirror tick error");
    }
    await sleep(env.INDEXER_POLL_INTERVAL_MS);
  }
}

async function tick(): Promise<void> {
  const cursor = await loadCursor();
  const latestBlock = await getLatestBlock();
  const fromBlock = Number(cursor.lastBlock) + 1;
  const toBlock = Math.min(fromBlock + env.INDEXER_BLOCK_BATCH_SIZE - 1, latestBlock);

  if (fromBlock > toBlock) {
    log.debug({ fromBlock, toBlock, latestBlock }, "Caught up, nothing to index");
    return;
  }

  log.info({ fromBlock, toBlock, latestBlock }, "Indexing block range");

  const rawEvents = await pollEvents(fromBlock, toBlock);
  log.debug({ count: rawEvents.length }, "Fetched marketplace events");

  const parsedEvents = parseEvents(rawEvents);
  const affectedContracts = new Set<string>();

  // All writes + cursor advance in one atomic transaction
  await prisma.$transaction(
    async (tx) => {
      for (const event of parsedEvents) {
        switch (event.type) {
          case "OrderCreated":
            await handleOrderCreated(event, tx);
            break;
          case "OrderFulfilled":
            await handleOrderFulfilled(event, tx);
            break;
          case "OrderCancelled":
            await handleOrderCancelled(event, tx);
            break;
          case "Transfer":
            await handleTransfer(event, tx);
            affectedContracts.add(event.contractAddress);
            break;
        }
      }
      // Cursor advances atomically with the event writes
      await saveCursor({ lastBlock: BigInt(toBlock), continuationToken: null }, tx);
    },
    { timeout: 30000 }
  );

  // Enqueue background jobs outside the transaction
  const pendingTokens = await prisma.token.findMany({
    where: {
      contractAddress: { in: Array.from(affectedContracts) },
      metadataStatus: "PENDING",
      tokenUri: null,
    },
    select: { contractAddress: true, tokenId: true },
    take: 200,
  });

  for (const token of pendingTokens) {
    await enqueueJob("METADATA_FETCH", {
      contractAddress: token.contractAddress,
      tokenId: token.tokenId,
    });
  }

  for (const contract of affectedContracts) {
    await enqueueJob("STATS_UPDATE", { contractAddress: contract });
  }

  log.info(
    { fromBlock, toBlock, events: parsedEvents.length, metadataJobs: pendingTokens.length },
    "Batch complete"
  );
}
