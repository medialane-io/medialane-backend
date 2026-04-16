import { randomUUID } from "crypto";
import { loadCursor, saveCursor } from "./cursor.js";
import { pollEvents, pollEvents1155, pollTransferEvents, pollCollectionCreatedEvents, pollCommentEvents, pollPopFactoryEvents, pollPopAllowlistEvents, pollDropFactoryEvents, pollDropAllowlistEvents, getLatestBlock } from "./poller.js";
import { parseEvents } from "./parser.js";
import { handleOrderCreated } from "./handlers/orderCreated.js";
import { handleOrderCreated1155 } from "./handlers/orderCreated1155.js";
import { handleOrderFulfilled } from "./handlers/orderFulfilled.js";
import { handleOrderCancelled } from "./handlers/orderCancelled.js";
import { dispatchTransfer } from "./handlers/transfer.js";
import { resolveCollectionCreated } from "./handlers/collectionCreated.js";
import { handleCommentAdded } from "./handlers/commentAdded.js";
import { handlePopCollectionCreated, handlePopAllowlistUpdated } from "./handlers/popFactory.js";
import { handleDropCreated, handleDropAllowlistUpdated } from "./handlers/dropFactory.js";
import { worker } from "../orchestrator/worker.js";
import { fanoutWebhooks, buildWebhookPayload } from "../orchestrator/webhookFanout.js";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { POP_FACTORY_CONTRACT, DROP_FACTORY_CONTRACT, ORDER_CREATED_SELECTOR, ORDER_FULFILLED_SELECTOR, ORDER_CANCELLED_SELECTOR } from "../config/constants.js";
import { num } from "starknet";
import { normalizeAddress } from "../utils/starknet.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const log = createLogger("mirror");
export const CHAIN = "STARKNET" as const;

// Blocks behind the chain tip before we skip the poll sleep to catch up faster.
const CATCHUP_THRESHOLD = 1000;
// Abort a hung tick after this many ms to prevent the loop from freezing.
const TICK_TIMEOUT_MS = 60_000;
// How often to poll Transfer events across all known NFT collections.
// Transfer events are polled on a separate (slower) schedule to avoid making one
// starknet_getEvents RPC call per collection per block — with 50 collections that
// was generating ~100M compute units/week at steady state.
// Tunable via TRANSFER_POLL_INTERVAL_MS env var (default 120s).
// Evaluated lazily so it picks up the parsed env value.
const transferPollIntervalMs = () => env.TRANSFER_POLL_INTERVAL_MS;

// Tracks the last block up to which Transfer events were fetched, and when.
// Kept in memory — a restart re-polls from the indexer cursor (safe, idempotent).
let _lastTransferPollTime = 0;
let _lastTransferBlock: number | null = null;

// Tracks the last block up to which POP allowlist events were fetched.
// Same slow-poll pattern as Transfer events.
let _lastPopAllowlistPollTime = 0;
let _lastPopAllowlistBlock: number | null = null;

// Tracks the last block up to which Drop allowlist events were fetched.
let _lastDropAllowlistPollTime = 0;
let _lastDropAllowlistBlock: number | null = null;

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

  // Poll marketplace events, ERC-1155 marketplace events, CollectionCreated events, etc. in parallel.
  const [rawMarketplaceEvents, raw1155Events, rawCollectionCreatedEvents, rawCommentEvents, rawPopFactoryEvents, rawDropFactoryEvents] = await Promise.all([
    pollEvents(fromBlock, toBlock),
    pollEvents1155(fromBlock, toBlock),
    pollCollectionCreatedEvents(fromBlock, toBlock),
    pollCommentEvents(fromBlock, toBlock),
    pollPopFactoryEvents(fromBlock, toBlock),
    pollDropFactoryEvents(fromBlock, toBlock),
  ]);

  // Poll Transfer events on a separate 2-minute schedule.
  // Previously this made one starknet_getEvents call per collection per block tick
  // (50 collections × every new block = ~100M compute units/week at steady state).
  // Now we batch: one call per collection every 2 minutes, covering the accumulated
  // block range, which is 1 call vs ~20 calls for the same block window.
  let rawTransferEvents: RawStarknetEvent[] = [];
  const now = Date.now();
  if (nftContracts.length > 0 && now - _lastTransferPollTime >= transferPollIntervalMs()) {
    const transferFromBlock = _lastTransferBlock != null ? _lastTransferBlock + 1 : fromBlock;
    if (transferFromBlock <= toBlock) {
      rawTransferEvents = (
        await Promise.all(nftContracts.map((addr) => pollTransferEvents(addr, transferFromBlock, toBlock)))
      ).flat();
    }
    _lastTransferBlock = toBlock;
    _lastTransferPollTime = now;
  }

  // Poll POP allowlist events on a slow schedule (same interval as Transfer events).
  // One starknet_getEvents call per known POP collection per interval.
  let rawPopAllowlistEvents: RawStarknetEvent[] = [];
  if (POP_FACTORY_CONTRACT && now - _lastPopAllowlistPollTime >= transferPollIntervalMs()) {
    const popCollections = await prisma.collection.findMany({
      where: { chain: CHAIN, source: "POP_PROTOCOL", startBlock: { lte: BigInt(toBlock) } },
      select: { contractAddress: true },
    });
    if (popCollections.length > 0) {
      const allowlistFromBlock = _lastPopAllowlistBlock != null ? _lastPopAllowlistBlock + 1 : fromBlock;
      if (allowlistFromBlock <= toBlock) {
        rawPopAllowlistEvents = (
          await Promise.all(popCollections.map((c) => pollPopAllowlistEvents(c.contractAddress, allowlistFromBlock, toBlock)))
        ).flat();
      }
    }
    _lastPopAllowlistBlock = toBlock;
    _lastPopAllowlistPollTime = now;
  }

  // Poll Drop allowlist events on the same slow schedule.
  let rawDropAllowlistEvents: RawStarknetEvent[] = [];
  if (DROP_FACTORY_CONTRACT && now - _lastDropAllowlistPollTime >= transferPollIntervalMs()) {
    const dropCollections = await prisma.collection.findMany({
      where: { chain: CHAIN, source: "COLLECTION_DROP", startBlock: { lte: BigInt(toBlock) } },
      select: { contractAddress: true },
    });
    if (dropCollections.length > 0) {
      const allowlistFromBlock = _lastDropAllowlistBlock != null ? _lastDropAllowlistBlock + 1 : fromBlock;
      if (allowlistFromBlock <= toBlock) {
        rawDropAllowlistEvents = (
          await Promise.all(dropCollections.map((c) => pollDropAllowlistEvents(c.contractAddress, allowlistFromBlock, toBlock)))
        ).flat();
      }
    }
    _lastDropAllowlistBlock = toBlock;
    _lastDropAllowlistPollTime = now;
  }

  const rawEvents = [...rawMarketplaceEvents, ...rawTransferEvents, ...rawCollectionCreatedEvents];
  tlog.debug(
    {
      marketplace: rawMarketplaceEvents.length,
      marketplace1155: raw1155Events.length,
      transfers: rawTransferEvents.length,
      collectionCreated: rawCollectionCreatedEvents.length,
      comments: rawCommentEvents.length,
      popFactory: rawPopFactoryEvents.length,
      popAllowlist: rawPopAllowlistEvents.length,
      dropFactory: rawDropFactoryEvents.length,
      dropAllowlist: rawDropAllowlistEvents.length,
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
      // ── ERC-721 marketplace events ───────────────────────────────────────
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
      for (const rawEvent of raw1155Events) {
        const selector = num.toHex(rawEvent.keys[0]);
        if (selector === SEL_CREATED) {
          const nftContract = await handleOrderCreated1155(rawEvent, tx, CHAIN);
          if (nftContract) orderNftContracts.add(nftContract);
        } else if (selector === SEL_FULFILLED || selector === SEL_CANCELLED) {
          // Fulfilled/Cancelled only need orderHash → re-use existing ERC-721 handlers
          const orderHash = num.toHex(rawEvent.keys[1]);
          const offerer   = normalizeAddress(rawEvent.keys[2]);
          const fulfiller = selector === SEL_FULFILLED ? normalizeAddress(rawEvent.keys[3]) : undefined;
          const blockNumber = BigInt(rawEvent.block_number);
          const txHash = rawEvent.transaction_hash ?? "";
          if (selector === SEL_FULFILLED) {
            await handleOrderFulfilled(
              { type: "OrderFulfilled", orderHash, offerer, fulfiller: fulfiller!, blockNumber, txHash, logIndex: 0 },
              tx, CHAIN
            );
            fulfilledOrCancelledHashes.push(orderHash);
          } else {
            await handleOrderCancelled(
              { type: "OrderCancelled", orderHash, offerer, blockNumber, txHash, logIndex: 0 },
              tx, CHAIN
            );
            fulfilledOrCancelledHashes.push(orderHash);
          }
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

  // Process CommentAdded events outside the main transaction (no cursor dependency, no downstream jobs)
  if (rawCommentEvents.length > 0) {
    const txCounters: Record<string, number> = {};
    for (const event of rawCommentEvents) {
      const txHash = event.transaction_hash ?? "";
      const logIndex = txCounters[txHash] ?? 0;
      txCounters[txHash] = logIndex + 1;
      await handleCommentAdded(event, txHash, logIndex);
    }
  }

  // Process POP factory CollectionCreated events (DB write only, collection_address is in data[0])
  for (const event of rawPopFactoryEvents) {
    await handlePopCollectionCreated(event);
    if (event.data?.[0]) {
      affectedContracts.add(normalizeAddress(event.data[0]));
    }
  }

  // Process POP AllowlistUpdated events (DB writes only, no RPC calls)
  for (const event of rawPopAllowlistEvents) {
    await handlePopAllowlistUpdated(event);
  }

  // Process Drop factory DropCreated events (DB write only, collection_address is in data[0])
  for (const event of rawDropFactoryEvents) {
    await handleDropCreated(event);
    if (event.data?.[0]) {
      affectedContracts.add(normalizeAddress(event.data[0]));
    }
  }

  // Process Drop AllowlistUpdated events (DB writes only, no RPC calls)
  for (const event of rawDropAllowlistEvents) {
    await handleDropAllowlistUpdated(event);
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
      popFactoryEvents: rawPopFactoryEvents.length,
      popAllowlistEvents: rawPopAllowlistEvents.length,
      dropFactoryEvents: rawDropFactoryEvents.length,
      dropAllowlistEvents: rawDropAllowlistEvents.length,
      parsed: parsedEvents.length,
      orderNftContracts: orderNftContracts.size,
      metadataJobs: allAffectedContracts.size,
    },
    "Batch complete"
  );
  return latestBlock - toBlock;
}
