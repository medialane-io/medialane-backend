import { createPublicClient, http, type PublicClient } from "viem";
import type { Chain } from "@prisma/client";
import { getCoordinates, type EvmCoordinates } from "@medialane/sdk";
import { prisma } from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import type { ChainIngestor } from "../ingestor.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { handleTransfer } from "../handlers/transfer.js";
import { env } from "../../config/env.js";
import { decodeEvmLogs, type EvmProtocolEvent } from "./decode.js";

const log = createLogger("evm-ingestor");

const POLL_MS = Number(process.env.EVM_POLL_INTERVAL_MS ?? 15_000);
const BATCH_BLOCKS = 2_000n;

/**
 * EVM chain ingestor (Ethereum + Base) — polls eth_getLogs over Medialane's
 * own contracts (venues + registries + collections discovered from
 * CollectionCreated) and reduces the events into the shared handlers.
 * Deploy-gated: dormant until the chain's coordinates carry addresses.
 * Foreign contracts are never bulk-indexed.
 */
export function makeEvmIngestor(chain: "ETHEREUM" | "BASE"): ChainIngestor {
  return {
    chain: chain as Chain,
    start() {
      const coords = maybeCoords(chain);
      const addresses = coords
        ? ([coords.marketplace721, coords.marketplace1155, coords.mipRegistry, coords.mipEditionsRegistry].filter(
            Boolean,
          ) as `0x${string}`[])
        : [];
      if (addresses.length === 0) {
        log.info({ chain }, "no coordinates configured — ingestor dormant until deploy");
        return;
      }
      const override = chain === "ETHEREUM" ? env.ETHEREUM_RPC_URL : env.BASE_RPC_URL;
      const client = createPublicClient({ transport: http(override ?? coords!.rpcUrl) });
      const startBlock = BigInt(
        coords!.marketplace721StartBlock ?? coords!.mipRegistryStartBlock ?? 0,
      );
      const tick = async () => {
        try {
          await pollOnce(chain as Chain, client, addresses, startBlock);
        } catch (err) {
          log.error({ err, chain }, "evm ingestor tick failed");
        } finally {
          setTimeout(tick, POLL_MS);
        }
      };
      void tick();
    },
  };
}

export async function pollOnce(
  chain: Chain,
  client: PublicClient,
  baseAddresses: `0x${string}`[],
  startBlock: bigint,
): Promise<void> {
  const cursor = await prisma.indexerCursor.findUnique({ where: { chain } });
  const from = cursor ? BigInt(cursor.lastBlock) + 1n : startBlock;
  const head = await client.getBlockNumber();
  if (from > head) return;
  const to = from + BATCH_BLOCKS - 1n > head ? head : from + BATCH_BLOCKS - 1n;

  // Our contracts only: the fixed set plus collections we've discovered.
  const known = await prisma.collection.findMany({
    where: { chain, service: { in: ["mip-erc721", "mip-erc1155"] } },
    select: { contractAddress: true },
  });
  const addresses = [...baseAddresses, ...known.map((c) => c.contractAddress as `0x${string}`)];

  const logs = await client.getLogs({ address: addresses, fromBlock: from, toBlock: to });
  const events = decodeEvmLogs(logs);
  await applyEvents(chain, events);

  await prisma.indexerCursor.upsert({
    where: { chain },
    create: { chain, lastBlock: to },
    update: { lastBlock: to },
  });
  if (events.length > 0) log.info({ chain, from: from.toString(), to: to.toString(), events: events.length }, "evm events applied");
}

/** Translate the decoded protocol events into the shared write paths. */
export async function applyEvents(chain: Chain, events: EvmProtocolEvent[]): Promise<void> {
  for (const event of events) {
    switch (event.kind) {
      case "CollectionCreated": {
        const coords = maybeCoords(chain as "ETHEREUM" | "BASE");
        const isEditions = coords?.mipEditionsRegistry?.toLowerCase() === event.registry.toLowerCase();
        await upsertCollectionFromFactory(prisma, {
          chain,
          contractAddress: event.collection,
          service: isEditions ? "mip-erc1155" : "mip-erc721",
          standard: isEditions ? "ERC1155" : "ERC721",
          name: event.name,
          symbol: event.symbol,
          baseUri: event.baseUri,
          owner: event.creator,
          startBlock: event.blockNumber,
          collectionId: event.collectionId.toString(),
        });
        break;
      }
      case "Transfer":
        await prisma.$transaction((tx) =>
          handleTransfer(
            {
              type: "Transfer",
              contractAddress: event.contract,
              tokenId: event.tokenId.toString(),
              from: event.from,
              to: event.to,
              blockNumber: event.blockNumber,
              txHash: event.txHash,
              logIndex: event.logIndex,
            },
            tx,
            chain,
          ),
        );
        break;
      case "OrderCreated":
        await prisma.order.upsert({
          where: { chain_orderHash: { chain, orderHash: event.orderHash } },
          create: {
            chain,
            orderHash: event.orderHash,
            offerer: event.offerer,
            status: "ACTIVE",
            createdBlockNumber: event.blockNumber,
            txHash: event.txHash,
          } as never,
          update: {},
        });
        break;
      case "OrderFulfilled":
        await prisma.order.updateMany({
          where: { chain, orderHash: event.orderHash },
          data: { status: "FULFILLED", fulfiller: event.fulfiller },
        });
        break;
      case "OrderCancelled":
        await prisma.order.updateMany({
          where: { chain, orderHash: event.orderHash },
          data: { status: "CANCELLED" },
        });
        break;
    }
  }
}

function maybeCoords(chain: "ETHEREUM" | "BASE"): EvmCoordinates | undefined {
  try {
    return getCoordinates(chain) as EvmCoordinates;
  } catch {
    return undefined;
  }
}
