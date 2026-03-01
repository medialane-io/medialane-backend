import { randomUUID } from "crypto";
import { loadCursor, saveCursor } from "./cursor.js";
import { pollEvents, pollTransferEvents, getLatestBlock } from "./poller.js";
import { parseEvents } from "./parser.js";
import { handleOrderCreated } from "./handlers/orderCreated.js";
import { handleOrderFulfilled } from "./handlers/orderFulfilled.js";
import { handleOrderCancelled } from "./handlers/orderCancelled.js";
import { handleTransfer } from "./handlers/transfer.js";
import { enqueueJob } from "../orchestrator/queue.js";
import { fanoutWebhooks, buildWebhookPayload } from "../orchestrator/webhookFanout.js";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { COLLECTION_CONTRACT } from "../config/constants.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mirror");
const CHAIN = "STARKNET" as const;

export async function startMirror(): Promise<void> {
  log.info({ chain: CHAIN }, "Mirror starting...");
  while (true) {
    // A short tickId lets you grep all log lines from one polling cycle
    const tickId = randomUUID().slice(0, 8);
    try {
      await tick(tickId);
    } catch (err) {
      log.error({ err, tickId }, "Mirror tick error");
    }
    await sleep(env.INDEXER_POLL_INTERVAL_MS);
  }
}

async function tick(tickId: string): Promise<void> {
  const tlog = log.child({ tickId });

  const cursor = await loadCursor(CHAIN);
  const latestBlock = await getLatestBlock();
  const fromBlock = Number(cursor.lastBlock) + 1;
  const toBlock = Math.min(fromBlock + env.INDEXER_BLOCK_BATCH_SIZE - 1, latestBlock);

  if (fromBlock > toBlock) {
    tlog.debug({ fromBlock, toBlock, latestBlock }, "Caught up, nothing to index");
    return;
  }

  tlog.info({ fromBlock, toBlock, latestBlock }, "Indexing block range");

  // Poll marketplace order events AND collection Transfer events in parallel
  const [rawMarketplaceEvents, rawTransferEvents] = await Promise.all([
    pollEvents(fromBlock, toBlock),
    pollTransferEvents(COLLECTION_CONTRACT, fromBlock, toBlock),
  ]);

  const rawEvents = [...rawMarketplaceEvents, ...rawTransferEvents];
  tlog.debug(
    { marketplace: rawMarketplaceEvents.length, transfers: rawTransferEvents.length },
    "Fetched events"
  );

  const parsedEvents = parseEvents(rawEvents);
  const affectedContracts = new Set<string>();

  // All writes + cursor advance in one atomic transaction
  await prisma.$transaction(
    async (tx) => {
      for (const event of parsedEvents) {
        switch (event.type) {
          case "OrderCreated":
            await handleOrderCreated(event, tx, CHAIN);
            break;
          case "OrderFulfilled":
            await handleOrderFulfilled(event, tx, CHAIN);
            break;
          case "OrderCancelled":
            await handleOrderCancelled(event, tx, CHAIN);
            break;
          case "Transfer":
            await handleTransfer(event, tx, CHAIN);
            affectedContracts.add(event.contractAddress);
            break;
        }
      }
      // Cursor advances atomically with the event writes
      await saveCursor({ lastBlock: BigInt(toBlock), continuationToken: null }, CHAIN, tx);
    },
    { timeout: 30000 }
  );

  // Enqueue background jobs outside the transaction
  const pendingTokens = await prisma.token.findMany({
    where: {
      chain: CHAIN,
      contractAddress: { in: Array.from(affectedContracts) },
      metadataStatus: "PENDING",
      tokenUri: null,
    },
    select: { contractAddress: true, tokenId: true },
    take: 200,
  });

  for (const token of pendingTokens) {
    await enqueueJob("METADATA_FETCH", {
      chain: CHAIN,
      contractAddress: token.contractAddress,
      tokenId: token.tokenId,
    });
  }

  for (const contract of affectedContracts) {
    await enqueueJob("STATS_UPDATE", { chain: CHAIN, contractAddress: contract });
  }

  // Fan out webhook deliveries for each parsed event (fire-and-forget errors)
  for (const event of parsedEvents) {
    const { eventType, payload } = buildWebhookPayload(event);
    fanoutWebhooks(eventType, payload).catch((err) =>
      tlog.warn({ err, eventType }, "Webhook fanout error")
    );
  }

  tlog.info(
    {
      fromBlock,
      toBlock,
      orderEvents: rawMarketplaceEvents.length,
      transferEvents: rawTransferEvents.length,
      parsed: parsedEvents.length,
      metadataJobs: pendingTokens.length,
    },
    "Batch complete"
  );
}
