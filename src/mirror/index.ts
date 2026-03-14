import { randomUUID } from "crypto";
import { loadCursor, saveCursor } from "./cursor.js";
import { pollEvents, pollTransferEvents, pollCollectionCreatedEvents, getLatestBlock } from "./poller.js";
import { parseEvents } from "./parser.js";
import { handleOrderCreated } from "./handlers/orderCreated.js";
import { handleOrderFulfilled } from "./handlers/orderFulfilled.js";
import { handleOrderCancelled } from "./handlers/orderCancelled.js";
import { handleTransfer } from "./handlers/transfer.js";
import { resolveCollectionCreated } from "./handlers/collectionCreated.js";
import { worker } from "../orchestrator/worker.js";
import { fanoutWebhooks, buildWebhookPayload } from "../orchestrator/webhookFanout.js";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mirror");
export const CHAIN = "STARKNET" as const;

// Blocks behind the chain tip before we skip the poll sleep to catch up faster.
const CATCHUP_THRESHOLD = 1000;
// Abort a hung tick after this many ms to prevent the loop from freezing.
const TICK_TIMEOUT_MS = 60_000;

export async function startMirror(): Promise<void> {
  log.info({ chain: CHAIN }, "Mirror starting...");
  while (true) {
    const tickId = randomUUID().slice(0, 8);
    let lagBlocks = 0;
    try {
      lagBlocks = await Promise.race([
        tick(tickId),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error(`tick timed out after ${TICK_TIMEOUT_MS}ms`)), TICK_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      log.error({ err, tickId }, "Mirror tick error");
    }
    // Skip sleep when catching up so we process batches back-to-back.
    if (lagBlocks <= CATCHUP_THRESHOLD) {
      await sleep(env.INDEXER_POLL_INTERVAL_MS);
    }
  }
}

async function tick(tickId: string): Promise<number> {
  const tlog = log.child({ tickId });

  const cursor = await loadCursor(CHAIN);
  const latestBlock = await getLatestBlock();
  const fromBlock = Number(cursor.lastBlock) + 1;
  const toBlock = Math.min(fromBlock + env.INDEXER_BLOCK_BATCH_SIZE - 1, latestBlock);

  if (fromBlock > toBlock) {
    tlog.debug({ fromBlock, toBlock, latestBlock }, "Caught up, nothing to index");
    return 0;
  }

  tlog.info({ fromBlock, toBlock, latestBlock }, "Indexing block range");

  // Load NFT collection contracts that existed at or before the current block range.
  // Filtering by startBlock prevents querying contracts that don't exist yet, which
  // avoids hammering the RPC with guaranteed-empty requests and causing rate-limit hangs.
  const knownCollections = await prisma.collection.findMany({
    where: { chain: CHAIN, startBlock: { lte: BigInt(toBlock) } },
    select: { contractAddress: true },
  });
  const nftContracts = knownCollections.map((c) => c.contractAddress);

  // Poll marketplace events and CollectionCreated events, then Transfer events from
  // every known NFT collection contract in parallel.
  const [rawMarketplaceEvents, rawCollectionCreatedEvents] = await Promise.all([
    pollEvents(fromBlock, toBlock),
    pollCollectionCreatedEvents(fromBlock, toBlock),
  ]);

  const rawTransferEvents = nftContracts.length > 0
    ? (await Promise.all(nftContracts.map((addr) => pollTransferEvents(addr, fromBlock, toBlock)))).flat()
    : [];

  const rawEvents = [...rawMarketplaceEvents, ...rawTransferEvents, ...rawCollectionCreatedEvents];
  tlog.debug(
    {
      marketplace: rawMarketplaceEvents.length,
      transfers: rawTransferEvents.length,
      collectionCreated: rawCollectionCreatedEvents.length,
      nftContractsPolled: nftContracts.length,
    },
    "Fetched events"
  );

  const parsedEvents = parseEvents(rawEvents);
  // Contracts from Transfer events (for existing METADATA_FETCH/STATS_UPDATE logic)
  const affectedContracts = new Set<string>();
  // NFT contracts extracted from Order events (listing + bid)
  const orderNftContracts = new Set<string>();
  // Order hashes from fulfilled/cancelled events (to look up their nftContract post-tx)
  const fulfilledOrCancelledHashes: string[] = [];
  // CollectionCreated events to resolve after the DB transaction
  const collectionCreatedEvents = parsedEvents.filter((e) => e.type === "CollectionCreated");

  // All writes + cursor advance in one atomic transaction (no async I/O inside)
  await prisma.$transaction(
    async (tx) => {
      for (const event of parsedEvents) {
        switch (event.type) {
          case "OrderCreated": {
            const nftContract = await handleOrderCreated(event, tx, CHAIN);
            if (nftContract) orderNftContracts.add(nftContract);
            break;
          }
          case "OrderFulfilled":
            await handleOrderFulfilled(event, tx, CHAIN);
            fulfilledOrCancelledHashes.push(event.orderHash);
            break;
          case "OrderCancelled":
            await handleOrderCancelled(event, tx, CHAIN);
            fulfilledOrCancelledHashes.push(event.orderHash);
            break;
          case "Transfer":
            await handleTransfer(event, tx, CHAIN);
            affectedContracts.add(event.contractAddress);
            break;
          // CollectionCreated handled after tx (requires on-chain call)
        }
      }
      // Cursor advances atomically with the event writes
      await saveCursor({ lastBlock: BigInt(toBlock), continuationToken: null }, CHAIN, tx);
    },
    { timeout: 60000 }
  );

  // Resolve CollectionCreated events outside the transaction (requires RPC call)
  for (const event of collectionCreatedEvents) {
    if (event.type !== "CollectionCreated") continue;
    const resolved = await resolveCollectionCreated(event);
    if (!resolved) continue;

    // Upsert collection first (always safe), then enqueue job separately so a
    // transient job-table failure cannot roll back the collection record.
    await prisma.collection.upsert({
      where: { chain_contractAddress: { chain: CHAIN, contractAddress: resolved.contractAddress } },
      create: {
        chain: CHAIN,
        contractAddress: resolved.contractAddress,
        collectionId: event.collectionId,
        name: resolved.name ?? undefined,
        symbol: resolved.symbol ?? undefined,
        baseUri: resolved.baseUri ?? undefined,
        owner: resolved.owner,
        startBlock: resolved.startBlock,
        metadataStatus: "PENDING",
      },
      update: {
        // Don't overwrite admin-set values
        collectionId: event.collectionId,
        name: resolved.name ?? undefined,
        symbol: resolved.symbol ?? undefined,
        owner: resolved.owner,
      },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: CHAIN, contractAddress: resolved.contractAddress });

    affectedContracts.add(resolved.contractAddress);
    tlog.info({ collectionId: event.collectionId, contractAddress: resolved.contractAddress }, "New collection indexed");
  }

  // Also collect nftContracts for fulfilled/cancelled orders (already in DB)
  if (fulfilledOrCancelledHashes.length > 0) {
    const orderRows = await prisma.order.findMany({
      where: { chain: CHAIN, orderHash: { in: fulfilledOrCancelledHashes } },
      select: { nftContract: true },
    });
    for (const row of orderRows) {
      if (row.nftContract) orderNftContracts.add(row.nftContract);
    }
  }

  // Merge all affected contracts for job enqueueing
  const allAffectedContracts = new Set([...affectedContracts, ...orderNftContracts]);

  // Enqueue background work — best-effort; worker deduplicates internally
  const pendingTokens = await prisma.token.findMany({
    where: {
      chain: CHAIN,
      contractAddress: { in: Array.from(allAffectedContracts) },
      metadataStatus: "PENDING",
      tokenUri: null,
    },
    select: { contractAddress: true, tokenId: true },
    take: 200,
  });
  for (const token of pendingTokens) {
    worker.enqueue({ type: "METADATA_FETCH", chain: CHAIN, contractAddress: token.contractAddress, tokenId: token.tokenId });
  }

  const pendingCollections = await prisma.collection.findMany({
    where: { chain: CHAIN, contractAddress: { in: Array.from(allAffectedContracts) }, metadataStatus: "PENDING" },
    select: { contractAddress: true },
  });
  for (const col of pendingCollections) {
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: CHAIN, contractAddress: col.contractAddress });
  }

  for (const contract of allAffectedContracts) {
    worker.enqueue({ type: "STATS_UPDATE", chain: CHAIN, contractAddress: contract });
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
      collectionCreatedEvents: collectionCreatedEvents.length,
      parsed: parsedEvents.length,
      orderNftContracts: orderNftContracts.size,
      metadataJobs: allAffectedContracts.size,
    },
    "Batch complete"
  );
  return latestBlock - toBlock;
}
