import { Hono } from "hono";
import { z } from "zod";
import { type Collection } from "@prisma/client";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/adminSecretAuth.js";
import { env } from "../../config/env.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { num as starkNum } from "starknet";
import { STARKNET_COLLECTION_721_CONTRACT, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { resolveCollectionCreated, decodeCollectionCreatedEvent } from "../../mirror/handlers/collectionCreated.js";
import { worker } from "../../orchestrator/worker.js";
import { toErrorMessage } from "../../utils/error.js";
import { callRpc } from "../../utils/starknet.js";
import { serializeCollection } from "../utils/serialize.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:collections");

const VALID_COLLECTION_STANDARDS = new Set(["ERC721", "ERC1155"]);

type ResolvedCollectionForSync = {
  contractAddress: string;
  owner: string;
  name: string | null;
  symbol: string | null;
  baseUri: string | null;
  startBlock: bigint;
};

function decodeByteArray(felts: string[], offset: number): { value: string; nextOffset: number } {
  if (offset >= felts.length) return { value: "", nextOffset: offset };
  const dataLen = Number(BigInt(felts[offset]));
  if (felts.length < offset + 1 + dataLen + 2) return { value: "", nextOffset: felts.length };

  const pendingWord = BigInt(felts[offset + 1 + dataLen] ?? "0x0");
  const pendingWordLen = Number(BigInt(felts[offset + 1 + dataLen + 1] ?? "0"));
  const bytes = new Uint8Array(dataLen * 31 + pendingWordLen);
  let byteOffset = 0;

  for (let i = 0; i < dataLen; i++) {
    const value = BigInt(felts[offset + 1 + i]);
    for (let j = 0; j < 31; j++) {
      bytes[byteOffset++] = Number((value >> BigInt((30 - j) * 8)) & 0xffn);
    }
  }

  for (let j = 0; j < pendingWordLen; j++) {
    bytes[byteOffset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
  }

  return {
    value: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    nextOffset: offset + 1 + dataLen + 2,
  };
}

function safeNormalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeAddress("STARKNET", value);
  } catch {
    return null;
  }
}

function resolveCollectionFromReceipt(
  collectionEvent: any,
  allEvents: any[],
  registryAddress: string,
  owner: string,
  blockNumber: bigint
): ResolvedCollectionForSync | null {
  const dataFelts = ((collectionEvent.data ?? []) as string[]).map((d) => starkNum.toHex(d));
  if (dataFelts.length < 6) return null;

  const { value: name, nextOffset: afterName } = decodeByteArray(dataFelts, 3);
  const { value: symbol, nextOffset: afterSymbol } = decodeByteArray(dataFelts, afterName);
  const { value: baseUri } = decodeByteArray(dataFelts, afterSymbol);

  const deployedEvent = allEvents.find((event: any) => {
    const fromAddress = safeNormalizeAddress(event.from_address);
    if (!fromAddress || fromAddress === registryAddress) return false;
    const data = (event.data ?? []) as string[];
    return data.some((felt) => safeNormalizeAddress(felt) === registryAddress);
  });

  const contractAddress = safeNormalizeAddress(deployedEvent?.from_address);
  if (!contractAddress) return null;

  return {
    contractAddress,
    owner,
    name: name || null,
    symbol: symbol || null,
    baseUri: baseUri || null,
    startBlock: blockNumber,
  };
}

/**
 * Collection WRITE paths — sync-tx (instant index from a receipt), register,
 * and the admin create. Split from collections.ts 2026-07-11 (audit
 * follow-up #8): the read surface and the receipt-decoding write machinery
 * change for different reasons. Registered onto the same /v1/collections
 * router (registrar pattern).
 */
export function registerCollectionSyncRoutes(collections: Hono) {
// POST /v1/collections/sync-tx — immediately index a CollectionCreated event from a tx receipt
// Call this right after a create_collection tx is confirmed to make the collection appear instantly.
collections.post("/sync-tx", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ txHash: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "txHash required" }, 400);

  const { txHash } = parsed.data;
  try {
    const receipt = await callRpc((provider) => provider.getTransactionReceipt(txHash));

    const collectionCreatedKey = starkNum.toHex(COLLECTION_CREATED_SELECTOR);
    const registryAddress = normalizeAddress("STARKNET", STARKNET_COLLECTION_721_CONTRACT);
    const events = (receipt as any).events ?? [];
    const collectionEvents = events.filter(
      (e: any) =>
        e.from_address &&
        normalizeAddress("STARKNET", e.from_address) === registryAddress &&
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

      let resolved = await resolveCollectionCreated({
        type: "CollectionCreated",
        collectionId,
        owner,
        blockNumber,
        txHash,
        logIndex: 0,
      });

      if (!resolved) {
        resolved = resolveCollectionFromReceipt(event, events, registryAddress, owner, blockNumber);
      }

      if (!resolved) {
        unresolved++;
        continue;
      }

      await prisma.collection.upsert({
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: resolved.contractAddress } },
        create: {
          chain: "STARKNET",
          contractAddress: resolved.contractAddress,
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          baseUri: resolved.baseUri ?? undefined,
          owner: resolved.owner,
          startBlock: resolved.startBlock,
          service: "mip-erc721",
          standard: "ERC721",
          metadataStatus: "PENDING",
        },
        update: {
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          owner: resolved.owner,
          service: "mip-erc721",
          standard: "ERC721",
        },
      });

      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: resolved.contractAddress });
      synced++;
      log.info({ txHash, contractAddress: resolved.contractAddress, owner }, "Collection synced from tx");
    }

    if (synced === 0 && unresolved > 0) {
      // RPC couldn't resolve the just-created collection right now (typically
      // transient RPC-provider flapping on get_collection). This is NOT a
      // failure: the mirror poll re-indexes the CollectionCreated event within
      // ~6s. Return 202 (accepted, async) instead of a misleading 502 that
      // alarms the client console for a self-healing condition.
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
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/collections/register — tenant-driven collection registration
collections.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.contractAddress) {
    return c.json({ error: "contractAddress is required" }, 400);
  }

  const contractAddress = normalizeAddress("STARKNET", body.contractAddress);
  const startBlock = typeof body.startBlock === "number" ? BigInt(body.startBlock) : BigInt(0);
  const standard =
    typeof body.standard === "string" && VALID_COLLECTION_STANDARDS.has(body.standard)
      ? body.standard
      : undefined;
  const service =
    typeof body.service === "string" && body.service.length > 0
      ? body.service
      : undefined;

  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (existing) {
    const collection = await prisma.collection.update({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
      data: {
        standard,
        ...(service ? { service } : {}),
        metadataStatus: "PENDING",
      },
    });
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress });
    return c.json({ data: serializeCollection(collection) });
  }

  // standard is required to create a Collection — caller must specify ERC721
  // or ERC1155. If not, refuse rather than guess (was silently defaulting to
  // UNKNOWN before, which has been dropped from the enum).
  if (!standard) {
    return c.json({ error: "standard is required (ERC721 or ERC1155)" }, 400);
  }
  const resolvedService =
    service ?? (standard === "ERC1155" ? "external-erc1155" : "external-erc721");
  const collection = await prisma.collection.create({
    data: {
      chain: "STARKNET",
      contractAddress,
      startBlock,
      metadataStatus: "PENDING",
      standard: standard as "ERC721" | "ERC1155",
      service: resolvedService,
    },
  });

  worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress });

  return c.json({ data: serializeCollection(collection) }, 201);
});

// POST /v1/collections — register a collection (admin)
collections.post("/", authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.contractAddress) {
    return c.json({ error: "contractAddress required" }, 400);
  }

  const startBlock = body.startBlock
    ? BigInt(body.startBlock)
    : BigInt(env.INDEXER_START_BLOCK);

  const contractAddress = normalizeAddress("STARKNET", body.contractAddress);

  // standard is required to create — caller must specify ERC721 or ERC1155.
  if (body.standard !== "ERC721" && body.standard !== "ERC1155") {
    return c.json({ error: "standard is required (ERC721 or ERC1155)" }, 400);
  }
  const adminStandard = body.standard as "ERC721" | "ERC1155";
  const adminService =
    body.service ?? (adminStandard === "ERC1155" ? "external-erc1155" : "external-erc721");
  const col = await prisma.collection.upsert({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    create: {
      chain: "STARKNET",
      contractAddress,
      name: body.name ?? null,
      symbol: body.symbol ?? null,
      description: body.description ?? null,
      image: body.image ?? null,
      baseUri: body.baseUri ?? null,
      owner: body.owner ? normalizeAddress("STARKNET", body.owner) : null,
      standard: adminStandard,
      service: adminService,
      startBlock,
    },
    update: {
      name: body.name ?? undefined,
      symbol: body.symbol ?? undefined,
      description: body.description ?? undefined,
      image: body.image ?? undefined,
      baseUri: body.baseUri ?? undefined,
      owner: body.owner ? normalizeAddress("STARKNET", body.owner) : undefined,
      standard: adminStandard,
    },
  });

  return c.json({ data: serializeCollection(col) }, 201);
});
}
