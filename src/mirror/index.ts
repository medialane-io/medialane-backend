import { randomUUID } from "crypto";
import { loadCursor, saveCursor, saveSourceCursor } from "./cursor.js";
import { getLatestBlock } from "./poller.js";
import { fetchDueSources, CORE_MARKETPLACE_721, CORE_MARKETPLACE_1155, CORE_FACTORY_MIP721, CORE_TRANSFERS, type SourceFetch } from "./sources.js";
import { parseEvents } from "./parser.js";
import { handleOrderCreated, handleOrderCreated1155 } from "./handlers/orderCreated.js";
import { handleOrderFulfilled, parseRawOrderFulfilled1155 } from "./handlers/orderFulfilled.js";
import { handleOrderCancelled } from "./handlers/orderCancelled.js";
import { handleCounterIncremented } from "./handlers/counterIncremented.js";
import { cleanupGhostListings } from "./handlers/ghostListingCleanup.js";
import { dispatchTransfer } from "./handlers/transfer.js";
import { resolveCollectionCreated } from "./handlers/collectionCreated.js";
import { upsertCollectionFromFactory } from "../utils/collection.js";
import { worker } from "../orchestrator/worker.js";
import { fanoutWebhooks, buildWebhookPayload } from "../orchestrator/webhookFanout.js";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { ORDER_CREATED_SELECTOR, ORDER_FULFILLED_SELECTOR, ORDER_CANCELLED_SELECTOR, COUNTER_INCREMENTED_SELECTOR } from "../config/constants.js";
import { num } from "starknet";
import { normalizeAddress } from "../utils/starknet.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";
import type { ParsedTransferSingle, ParsedTransfer } from "../types/marketplace.js";

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
    // Always sleep at least 500ms even in catchup mode to avoid saturating the RPC
    // endpoint during historical backfills. When caught up, sleep the full interval.
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
  // Trail the chain tip by a small confirmation buffer — a minimal reorg-safety
  // margin. `latestBlock` (the true tip) is still used for lag reporting below;
  // only the polling window itself stays behind it.
  const safeLatestBlock = Math.max(latestBlock - env.INDEXER_CONFIRMATION_BLOCKS, 0);
  const fromBlock = Number(cursor.lastBlock) + 1;
  const toBlock = Math.min(fromBlock + env.INDEXER_BLOCK_BATCH_SIZE - 1, safeLatestBlock);

  if (fromBlock > toBlock) {
    tlog.debug({ fromBlock, toBlock, latestBlock }, "Caught up, nothing to index");
    return 0;
  }

  tlog.info({ fromBlock, toBlock, latestBlock }, "Indexing block range");

  // One generic sweep over the declarative source table (sources.ts): every
  // due source fetches its events for this window; slow-cadence sources
  // resume from their durable SourceCursor.
  const fetches = await fetchDueSources({ chain: CHAIN, fromBlock, toBlock, now: Date.now() });
  const byId = new Map<string, SourceFetch>(fetches.map((f) => [f.source.id, f]));
  const eventsOf = (id: string) => byId.get(id)?.events ?? [];

  // Core sources feed the atomic parse/write transaction below.
  const rawMarketplaceEvents = eventsOf(CORE_MARKETPLACE_721);
  const raw1155Events = eventsOf(CORE_MARKETPLACE_1155);
  const rawCollectionCreatedEvents = eventsOf(CORE_FACTORY_MIP721);
  const rawTransferEvents = eventsOf(CORE_TRANSFERS);

  const rawEvents = [...rawMarketplaceEvents, ...rawTransferEvents, ...rawCollectionCreatedEvents];
  tlog.debug(
    Object.fromEntries(fetches.map((f) => [f.source.id, f.events.length])),
    "Fetched events"
  );

  const parsedEvents = parseEvents(rawEvents);

  // Some ERC-1155 contracts emit both Transfer (ERC-721 compat) and TransferSingle for the same
  // operation. Both events get different logIndexes and both pass createTransferIfNew, causing
  // each buyer's balance to be incremented twice. Deduplicate by dropping Transfer events when
  // a TransferSingle exists for the same (txHash, contractAddress, tokenId, from, to).
  const transferSingleFingerprints = new Set(
    parsedEvents
      .filter((e): e is ParsedTransferSingle => e.type === "TransferSingle")
      .map((e) => `${e.txHash}:${e.contractAddress}:${e.tokenId}:${e.from}:${e.to}`)
  );
  const deduplicatedEvents = parsedEvents.filter((e) => {
    if (e.type !== "Transfer") return true;
    const t = e as ParsedTransfer;
    return !transferSingleFingerprints.has(`${t.txHash}:${t.contractAddress}:${t.tokenId}:${t.from}:${t.to}`);
  });

  // Contracts from Transfer events (for existing METADATA_FETCH/STATS_UPDATE logic)
  const affectedContracts = new Set<string>();
  // NFT contracts extracted from Order events (listing + bid)
  const orderNftContracts = new Set<string>();
  // Order hashes from fulfilled/cancelled events (to look up their nftContract post-tx)
  const fulfilledOrCancelledHashes: string[] = [];
  // CollectionCreated events to resolve after the DB transaction
  const collectionCreatedEvents = deduplicatedEvents.filter((e) => e.type === "CollectionCreated");

  // All writes + cursor advance in one atomic transaction (no async I/O inside)
  await prisma.$transaction(
    async (tx) => {
      // ── ERC-721 marketplace events ───────────────────────────────────────
      for (const event of deduplicatedEvents) {
        switch (event.type) {
          case "OrderCreated": {
            const nftContract = await handleOrderCreated(event, tx, CHAIN);
            if (nftContract) orderNftContracts.add(nftContract);
            break;
          }
          case "OrderFulfilled":
            await handleOrderFulfilled(event, tx, CHAIN);
            await cleanupGhostListings(event.orderHash, tx, CHAIN);
            fulfilledOrCancelledHashes.push(event.orderHash);
            break;
          case "OrderCancelled":
            await handleOrderCancelled(event, tx, CHAIN);
            fulfilledOrCancelledHashes.push(event.orderHash);
            break;
          case "CounterIncremented":
            await handleCounterIncremented(event, tx, CHAIN);
            break;
          case "Transfer":
          case "TransferSingle":
          case "TransferBatch":
            await dispatchTransfer(event, tx, CHAIN);
            affectedContracts.add(event.contractAddress);
            break;
          // CollectionCreated handled after tx (requires on-chain call)
        }
      }

      // ── ERC-1155 marketplace events ──────────────────────────────────────
      // Raw events are processed directly — ERC-1155 OrderCreated carries all
      // data in the event itself (no RPC get_order_details call needed).
      const SEL_CREATED   = num.toHex(ORDER_CREATED_SELECTOR);
      const SEL_FULFILLED = num.toHex(ORDER_FULFILLED_SELECTOR);
      const SEL_CANCELLED = num.toHex(ORDER_CANCELLED_SELECTOR);
      const SEL_COUNTER   = num.toHex(COUNTER_INCREMENTED_SELECTOR);
      // Per-tx log counter for 1155 events — matches the ERC-721 parser's txCounters
      // so logIndex values stay consistent if handlers ever use them for idempotency.
      const txCounters1155 = new Map<string, number>();
      for (const rawEvent of raw1155Events) {
        const selector = num.toHex(rawEvent.keys[0]);
        const evTxHash = rawEvent.transaction_hash ?? "";
        const logIndex = txCounters1155.get(evTxHash) ?? 0;
        txCounters1155.set(evTxHash, logIndex + 1);
        if (selector === SEL_CREATED) {
          const nftContract = await handleOrderCreated1155(rawEvent, tx, CHAIN);
          if (nftContract) orderNftContracts.add(nftContract);
        } else if (selector === SEL_FULFILLED || selector === SEL_CANCELLED) {
          // Fulfilled/Cancelled only need orderHash → re-use existing ERC-721 handlers
          const orderHash = num.toHex(rawEvent.keys[1]);
          const offerer   = normalizeAddress("STARKNET", rawEvent.keys[2]);
          const blockNumber = BigInt(rawEvent.block_number);
          if (selector === SEL_FULFILLED) {
            const parsed = parseRawOrderFulfilled1155(rawEvent, logIndex);
            const { isFinalFill } = await handleOrderFulfilled(parsed, tx, CHAIN);
            if (isFinalFill) await cleanupGhostListings(orderHash, tx, CHAIN);
            fulfilledOrCancelledHashes.push(orderHash);
          } else {
            await handleOrderCancelled(
              { type: "OrderCancelled", orderHash, offerer, blockNumber, txHash: evTxHash, logIndex },
              tx, CHAIN
            );
            fulfilledOrCancelledHashes.push(orderHash);
          }
        } else if (selector === SEL_COUNTER) {
          await handleCounterIncremented(
            {
              type: "CounterIncremented",
              offerer: normalizeAddress("STARKNET", rawEvent.keys[1]),
              newCounter: BigInt(rawEvent.data[0]).toString(),
              blockNumber: BigInt(rawEvent.block_number),
              txHash: evTxHash,
              logIndex,
            },
            tx, CHAIN
          );
        }
      }

      // Cursor advances atomically with the event writes
      await saveCursor({ lastBlock: BigInt(toBlock), continuationToken: null }, CHAIN, tx);

      // Transfer writes and the transfers cursor advance atomically — a failed
      // tick re-polls the same window (handlers are idempotent).
      const transferFetch = byId.get(CORE_TRANSFERS);
      if (transferFetch && transferFetch.cursorTo != null) {
        await saveSourceCursor(CHAIN, CORE_TRANSFERS, BigInt(transferFetch.cursorTo), tx);
      }
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
    await upsertCollectionFromFactory(prisma, {
      chain: CHAIN,
      contractAddress: resolved.contractAddress,
      service: "mip-erc721",
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

  // Reduce side sources (everything that isn't the core order/transfer/
  // mip-721-factory pipeline) and advance their durable cursors on success —
  // a failed apply leaves the cursor behind, so the window replays next time
  // (handlers are idempotent upserts).
  const ctx = { affectedContracts };
  for (const fetch of fetches) {
    if (!fetch.source.apply) continue;
    await fetch.source.apply(fetch.events, ctx);
    if (fetch.cursorTo != null) {
      await saveSourceCursor(CHAIN, fetch.source.id, BigInt(fetch.cursorTo));
    }
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

  // Fan out webhook deliveries for each deduplicated event (fire-and-forget errors)
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
