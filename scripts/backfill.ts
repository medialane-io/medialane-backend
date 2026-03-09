#!/usr/bin/env bun
/**
 * One-shot historical backfill using Voyager API.
 * Usage: bun run scripts/backfill.ts [--from <block>] [--to <block>]
 */

import { pollEvents, pollTransferEvents, pollCollectionCreatedEvents } from "../src/mirror/poller.js";
import { parseEvents } from "../src/mirror/parser.js";
import { handleOrderCreated } from "../src/mirror/handlers/orderCreated.js";
import { handleOrderFulfilled } from "../src/mirror/handlers/orderFulfilled.js";
import { handleOrderCancelled } from "../src/mirror/handlers/orderCancelled.js";
import { handleTransfer } from "../src/mirror/handlers/transfer.js";
import { resolveCollectionCreated } from "../src/mirror/handlers/collectionCreated.js";
import { saveCursor } from "../src/mirror/cursor.js";
import { enqueueJob } from "../src/orchestrator/queue.js";
import prisma from "../src/db/client.js";
import { env } from "../src/config/env.js";
import { createLogger } from "../src/utils/logger.js";

const log = createLogger("backfill");
const CHAIN = "STARKNET" as const;

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
      // Load known NFT collection contracts at each batch so newly-discovered ones are included
      const knownCollections = await prisma.collection.findMany({
        where: { chain: CHAIN },
        select: { contractAddress: true },
      });
      const nftContracts = knownCollections.map((c) => c.contractAddress);

      const [rawMarketplaceEvents, rawCollectionCreatedEvents] = await Promise.all([
        pollEvents(start, end),
        pollCollectionCreatedEvents(start, end),
      ]);
      const rawTransferEvents = nftContracts.length > 0
        ? (await Promise.all(nftContracts.map((addr) => pollTransferEvents(addr, start, end)))).flat()
        : [];

      const rawEvents = [...rawMarketplaceEvents, ...rawTransferEvents, ...rawCollectionCreatedEvents];
      const parsedEvents = parseEvents(rawEvents);

      // Resolve CollectionCreated events so newly discovered contracts are in DB for next batch
      const collectionCreatedEvents = parsedEvents.filter((e) => e.type === "CollectionCreated");
      for (const event of collectionCreatedEvents) {
        if (event.type !== "CollectionCreated") continue;
        const resolved = await resolveCollectionCreated(event);
        if (!resolved) continue;
        await prisma.collection.upsert({
          where: { chain_contractAddress: { chain: CHAIN, contractAddress: resolved.contractAddress } },
          create: {
            chain: CHAIN,
            contractAddress: resolved.contractAddress,
            name: resolved.name ?? undefined,
            symbol: resolved.symbol ?? undefined,
            baseUri: resolved.baseUri ?? undefined,
            owner: resolved.owner,
            startBlock: resolved.startBlock,
            metadataStatus: "PENDING",
          },
          update: { name: resolved.name ?? undefined, symbol: resolved.symbol ?? undefined, owner: resolved.owner },
        });
      }

      await prisma.$transaction(
        async (tx) => {
          for (const event of parsedEvents) {
            switch (event.type) {
              case "OrderCreated":
                await handleOrderCreated(event, tx as any, CHAIN);
                break;
              case "OrderFulfilled":
                await handleOrderFulfilled(event, tx as any, CHAIN);
                break;
              case "OrderCancelled":
                await handleOrderCancelled(event, tx as any, CHAIN);
                break;
              case "Transfer":
                await handleTransfer(event, tx as any, CHAIN);
                break;
            }
          }
          await saveCursor({ lastBlock: BigInt(end), continuationToken: null }, CHAIN);
        },
        { timeout: 60000 }
      );

      // Enqueue metadata jobs for new tokens
      const pendingTokens = await prisma.token.findMany({
        where: { chain: CHAIN, metadataStatus: "PENDING", tokenUri: null },
        select: { contractAddress: true, tokenId: true },
        take: 100,
      });

      for (const t of pendingTokens) {
        await enqueueJob("METADATA_FETCH", { chain: CHAIN, ...t });
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
