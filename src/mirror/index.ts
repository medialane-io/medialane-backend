import { randomUUID } from "crypto";
import { loadCursor, saveCursor, saveSourceCursor } from "./cursor.js";
import { getLatestBlock } from "./poller.js";
import { serviceForFactory } from "../utils/factoryService.js";
import { fetchDueSources, CORE_MARKETPLACE_721, CORE_MARKETPLACE_1155, CORE_FACTORY_MIP721, CORE_FACTORY_DATA_TOKENIZATION, CORE_TRANSFERS, type SourceFetch } from "./sources.js";
import { applyEvents, type ApplyOutcome } from "./apply.js";
import { resolveCollectionCreated } from "./handlers/collectionCreated.js";
import { upsertCollectionFromFactory } from "../utils/collection.js";
import { worker } from "../orchestrator/worker.js";
import { fanoutWebhooks, buildWebhookPayload } from "../orchestrator/webhookFanout.js";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mirror");
export const CHAIN = "STARKNET" as const;

const CATCHUP_THRESHOLD = 1000;

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

    if (lagBlocks <= CATCHUP_THRESHOLD) {
      await sleep(env.INDEXER_POLL_INTERVAL_MS);
    } else {
      await sleep(500);
    }
  }
}

async function tick(tickId: string): Promise<number> {
  const tlog = log.child({ tickId });

  const cursor = await loadCursor(CHAIN);
  const latestBlock = await getLatestBlock();

  const safeLatestBlock = Math.max(latestBlock - env.INDEXER_CONFIRMATION_BLOCKS, 0);
  const fromBlock = Number(cursor.lastBlock) + 1;
  const toBlock = Math.min(fromBlock + env.INDEXER_BLOCK_BATCH_SIZE - 1, safeLatestBlock);

  if (fromBlock > toBlock) {
    tlog.debug({ fromBlock, toBlock, latestBlock }, "Caught up, nothing to index");
    return 0;
  }

  tlog.info({ fromBlock, toBlock, latestBlock }, "Indexing block range");

  const fetches = await fetchDueSources({ chain: CHAIN, fromBlock, toBlock, now: Date.now() });
  const byId = new Map<string, SourceFetch>(fetches.map((f) => [f.source.id, f]));
  const eventsOf = (id: string) => byId.get(id)?.events ?? [];

  const rawMarketplaceEvents = eventsOf(CORE_MARKETPLACE_721);
  const raw1155Events = eventsOf(CORE_MARKETPLACE_1155);
  const rawCollectionCreatedEvents = [
    ...eventsOf(CORE_FACTORY_MIP721),
    ...eventsOf(CORE_FACTORY_DATA_TOKENIZATION),
  ];
  const rawTransferEvents = eventsOf(CORE_TRANSFERS);

  const rawEvents = [
    ...rawMarketplaceEvents,
    ...raw1155Events,
    ...rawTransferEvents,
    ...rawCollectionCreatedEvents,
  ];
  tlog.debug(
    Object.fromEntries(fetches.map((f) => [f.source.id, f.events.length])),
    "Fetched events"
  );

  let outcome!: ApplyOutcome;

  await prisma.$transaction(
    async (tx) => {
      outcome = await applyEvents(rawEvents, tx, CHAIN);

      await saveCursor({ lastBlock: BigInt(toBlock), continuationToken: null }, CHAIN, tx);

      const transferFetch = byId.get(CORE_TRANSFERS);
      if (transferFetch && transferFetch.cursorTo != null) {
        await saveSourceCursor(CHAIN, CORE_TRANSFERS, BigInt(transferFetch.cursorTo), tx);
      }
    },
    { timeout: 60000 }
  );

  const deduplicatedEvents = outcome.parsed;
  const affectedContracts = outcome.affectedContracts;
  const orderNftContracts = outcome.orderNftContracts;
  const fulfilledOrCancelledHashes = outcome.fulfilledOrCancelledHashes;
  const collectionCreatedEvents = deduplicatedEvents.filter(
    (e: ApplyOutcome["parsed"][number]) => e.type === "CollectionCreated",
  );

  for (const event of collectionCreatedEvents) {
    if (event.type !== "CollectionCreated") continue;
    const resolved = await resolveCollectionCreated(event);
    if (!resolved) continue;

    await upsertCollectionFromFactory(prisma, {
      chain: CHAIN,
      contractAddress: resolved.contractAddress,
      service: serviceForFactory(event.factoryAddress),
      standard: "ERC721",
      collectionId: event.collectionId,
      name: resolved.name,
      symbol: resolved.symbol,
      baseUri: resolved.baseUri,
      owner: resolved.owner,
      startBlock: resolved.startBlock,
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: CHAIN, contractAddress: resolved.contractAddress });

    affectedContracts.add(resolved.contractAddress);
    tlog.info({ collectionId: event.collectionId, contractAddress: resolved.contractAddress }, "New collection indexed");
  }

  const ctx = { affectedContracts };
  for (const fetch of fetches) {
    if (!fetch.source.apply) continue;
    await fetch.source.apply(fetch.events, ctx);
    if (fetch.cursorTo != null) {
      await saveSourceCursor(CHAIN, fetch.source.id, BigInt(fetch.cursorTo));
    }
  }

  if (fulfilledOrCancelledHashes.length > 0) {
    const orderRows = await prisma.order.findMany({
      where: { chain: CHAIN, orderHash: { in: fulfilledOrCancelledHashes } },
      select: { nftContract: true },
    });
    for (const row of orderRows) {
      if (row.nftContract) orderNftContracts.add(row.nftContract);
    }
  }

  const allAffectedContracts = new Set([...affectedContracts, ...orderNftContracts]);

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

  for (const event of deduplicatedEvents) {
    const { eventType, payload } = buildWebhookPayload(event);
    fanoutWebhooks(eventType, payload).catch((err) =>
      tlog.warn({ err, eventType }, "Webhook fanout error")
    );
  }

  tlog.info(
    {
      fromBlock,
      toBlock,
      sources: Object.fromEntries(fetches.map((f) => [f.source.id, f.events.length])),
      parsed: deduplicatedEvents.length,
      orderNftContracts: orderNftContracts.size,
      metadataJobs: allAffectedContracts.size,
    },
    "Batch complete"
  );
  return latestBlock - toBlock;
}
