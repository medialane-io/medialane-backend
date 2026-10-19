import { Hono } from "hono";
import { z } from "zod";
import { type Collection, type PrismaClient } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { num as starkNum } from "starknet";
import { STARKNET_COLLECTION_FACTORIES, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { resolveCollectionCreated, decodeCollectionCreatedEvent } from "../../mirror/handlers/collectionCreated.js";
import { worker } from "../../orchestrator/worker.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { serviceForFactory } from "../../utils/factoryService.js";
import { callRpc } from "../../utils/starknet.js";
import { serializeCollections } from "../utils/serialize.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:collections");

export async function refreshIndexedCollection(
  db: Pick<PrismaClient, "collection">,
  contractAddress: string,
): Promise<Collection | null> {
  const where = { chain_contractAddress: { chain: "STARKNET" as const, contractAddress } };
  const existing = await db.collection.findUnique({ where });
  if (!existing) return null;
  return db.collection.update({ where, data: { metadataStatus: "PENDING" } });
}

export function registerCollectionSyncRoutes(collections: Hono) {

collections.post("/sync-tx", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ txHash: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "txHash required" }, 400);

  const { txHash } = parsed.data;
  try {
    const receipt = await callRpc((provider) => provider.getTransactionReceipt(txHash));

    const collectionCreatedKey = starkNum.toHex(COLLECTION_CREATED_SELECTOR);
    const factoryAddresses = new Set(STARKNET_COLLECTION_FACTORIES.map((a) => normalizeAddress("STARKNET", a)));
    const events = (receipt as any).events ?? [];
    const collectionEvents = events.filter(
      (e: any) =>
        e.from_address &&
        factoryAddresses.has(normalizeAddress("STARKNET", e.from_address)) &&
        e.keys?.[0] && starkNum.toHex(e.keys[0]) === collectionCreatedKey
    );

    if (collectionEvents.length === 0) {
      return c.json({ data: { synced: 0, message: "No CollectionCreated event found in this transaction" } });
    }

    let synced = 0;
    let unresolved = 0;
    for (const event of collectionEvents) {
      const decoded = decodeCollectionCreatedEvent(event);
      if (!decoded) continue;
      const { collectionId, owner } = decoded;
      const blockNumber = BigInt(event.block_number ?? (receipt as any).block_number ?? 0);

      const resolved = await resolveCollectionCreated({
        type: "CollectionCreated",
        collectionId,
        owner,
        factoryAddress: normalizeAddress("STARKNET", event.from_address),
        blockNumber,
        txHash,
        logIndex: 0,
      });

      if (!resolved) {
        unresolved++;
        continue;
      }

      await upsertCollectionFromFactory(prisma, {
        chain: "STARKNET",
        contractAddress: resolved.contractAddress,
        service: serviceForFactory(event.from_address),
        standard: "ERC721",
        collectionId,
        name: resolved.name,
        symbol: resolved.symbol,
        baseUri: resolved.baseUri,
        owner: resolved.owner,
        startBlock: resolved.startBlock,
      });

      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: resolved.contractAddress });
      synced++;
      log.info({ txHash, contractAddress: resolved.contractAddress, owner }, "Collection synced from tx");
    }

    if (synced === 0 && unresolved > 0) {

      log.warn({ txHash, unresolved }, "sync-tx: RPC unresolved — deferring to indexer poll");
      return c.json(
        {
          data: { synced, unresolved, deferred: true },
          message:
            "RPC unavailable for instant sync — this collection will be indexed by the poll shortly.",
        },
        202
      );
    }

    return c.json({ data: { synced } });
  } catch (err) {
    log.error({ err, txHash }, "sync-tx failed");
    return c.json({ error: "We could not sync that transaction. Please try again in a moment." }, 500);
  }
});

collections.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.contractAddress !== "string") {
    return c.json({ error: "contractAddress is required" }, 400);
  }
  let contractAddress: string;
  try {
    contractAddress = normalizeAddress("STARKNET", body.contractAddress);
  } catch {
    return c.json({ error: "Invalid contractAddress" }, 400);
  }

  const collection = await refreshIndexedCollection(prisma, contractAddress);
  if (!collection) {
    return c.json({ error: "This collection is not indexed yet" }, 404);
  }
  worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress });
  const [data] = await serializeCollections([collection]);
  return c.json({ data });
});

}
