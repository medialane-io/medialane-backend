import type { Chain } from "@prisma/client";
import { getCoordinates, type SolanaCoordinates } from "@medialane/sdk";
import { prisma } from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import type { ChainIngestor } from "../ingestor.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { env } from "../../config/env.js";
import { decodeSolanaLogs, type SolanaProtocolEvent } from "./decode.js";

const log = createLogger("solana-ingestor");

const POLL_MS = Number(process.env.SOLANA_POLL_INTERVAL_MS ?? 20_000);
const PAGE = 100;

/**
 * Solana chain ingestor — pages `getSignaturesForAddress` over our two
 * programs (issuance + venue), decodes Anchor events from each transaction's
 * logs, and reduces them into the shared write paths. Cursor = the newest
 * processed signature (IndexerCursor.continuationToken). Deploy-gated.
 */
export function makeSolanaIngestor(): ChainIngestor {
  return {
    chain: "SOLANA" as Chain,
    start() {
      const coords = maybeCoords();
      const programs = [coords?.mipCollectionsProgram, coords?.marketplaceProgram].filter(
        Boolean,
      ) as string[];
      if (programs.length === 0) {
        log.info("no coordinates configured — ingestor dormant until deploy");
        return;
      }
      const rpcUrl = env.SOLANA_RPC_URL ?? coords!.rpcUrl;
      const tick = async () => {
        try {
          for (const program of programs) await pollProgram(rpcUrl, program);
        } catch (err) {
          log.error({ err }, "solana ingestor tick failed");
        } finally {
          setTimeout(tick, POLL_MS);
        }
      };
      void tick();
    },
  };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`solana rpc ${method}: ${json.error.message}`);
  return json.result as T;
}

export async function pollProgram(rpcUrl: string, program: string): Promise<void> {
  // Per-program signature cursors live as a JSON map in the chain's
  // IndexerCursor.continuationToken (lastBlock carries the latest slot).
  const cursor = await prisma.indexerCursor.findUnique({ where: { chain: "SOLANA" } });
  const map: Record<string, string> = cursor?.continuationToken
    ? (JSON.parse(cursor.continuationToken) as Record<string, string>)
    : {};
  const until = map[program];

  const signatures = await rpc<{ signature: string }[]>(rpcUrl, "getSignaturesForAddress", [
    program,
    { limit: PAGE, ...(until ? { until } : {}) },
  ]);
  if (signatures.length === 0) return;

  // Oldest-first so the cursor only advances past applied transactions.
  for (const { signature } of [...signatures].reverse()) {
    const tx = await rpc<{ meta?: { logMessages?: string[] }; slot?: number } | null>(
      rpcUrl,
      "getTransaction",
      [signature, { maxSupportedTransactionVersion: 0 }],
    );
    const logs = tx?.meta?.logMessages ?? [];
    await applyEvents(decodeSolanaLogs(logs), BigInt(tx?.slot ?? 0), signature);
    map[program] = signature;
    const token = JSON.stringify(map);
    await prisma.indexerCursor.upsert({
      where: { chain: "SOLANA" },
      create: { chain: "SOLANA", lastBlock: BigInt(tx?.slot ?? 0), continuationToken: token },
      update: { lastBlock: BigInt(tx?.slot ?? 0), continuationToken: token },
    });
  }
  log.info({ program, processed: signatures.length }, "solana signatures applied");
}

export async function applyEvents(
  events: SolanaProtocolEvent[],
  slot: bigint,
  signature: string,
): Promise<void> {
  const chain = "SOLANA" as Chain;
  for (const event of events) {
    switch (event.kind) {
      case "CollectionCreated":
        await upsertCollectionFromFactory(prisma, {
          chain,
          contractAddress: event.coreCollection,
          service: "mip-erc721",
          standard: "ERC721",
          name: event.name,
          baseUri: event.uri,
          owner: event.creator,
          startBlock: slot,
          collectionId: event.collectionId.toString(),
        });
        break;
      case "AssetMinted":
        // Core assets are their own accounts; the token row keys on the
        // collection with the asset pubkey as the token id.
        await prisma.token.upsert({
          where: {
            chain_contractAddress_tokenId: {
              chain,
              contractAddress: event.coreCollection,
              tokenId: event.asset,
            },
          },
          create: {
            chain,
            contractAddress: event.coreCollection,
            tokenId: event.asset,
            tokenUri: event.uri,
            metadataStatus: "PENDING",
          } as never,
          update: {},
        });
        break;
      case "OrderCreated":
        await prisma.order.upsert({
          where: { chain_orderHash: { chain, orderHash: event.order } },
          create: {
            chain,
            orderHash: event.order,
            offerer: event.offerer,
            status: "ACTIVE",
            createdBlockNumber: slot,
            txHash: signature,
          } as never,
          update: {},
        });
        break;
      case "OrderFulfilled":
        await prisma.order.updateMany({
          where: { chain, orderHash: event.order },
          data: { status: "FULFILLED", fulfiller: event.fulfiller },
        });
        break;
      case "OrderCancelled":
        await prisma.order.updateMany({
          where: { chain, orderHash: event.order },
          data: { status: "CANCELLED" },
        });
        break;
      case "CounterIncremented":
        break; // informational; order invalidation is enforced on-chain at fill
    }
  }
}

function maybeCoords(): SolanaCoordinates | undefined {
  try {
    return getCoordinates("SOLANA") as SolanaCoordinates;
  } catch {
    return undefined;
  }
}
