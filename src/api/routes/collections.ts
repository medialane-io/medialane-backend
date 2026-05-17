import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { RawCollectionRow, RawCountRow } from "../utils/rawTypes.js";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../../config/env.js";
import { serializeToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { num as starkNum } from "starknet";
import { COLLECTION_721_CONTRACT, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { resolveCollectionCreated, decodeCollectionCreatedEvent } from "../../mirror/handlers/collectionCreated.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { callRpc } from "../../utils/starknet.js";

const log = createLogger("routes:collections");

const collections = new Hono();

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
    return normalizeAddress(value);
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

// Valid sort values for GET /v1/collections
const COLLECTION_SORT_VALUES = ["recent", "supply", "floor", "volume", "name"] as const;
type CollectionSort = (typeof COLLECTION_SORT_VALUES)[number];

const VALID_COLLECTION_STANDARDS = new Set(["ERC721", "ERC1155", "UNKNOWN"]);

// GET /v1/collections
collections.get("/", async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const isFeatured   = c.req.query("isFeatured") ?? c.req.query("isKnown");
  const owner     = c.req.query("owner");
  const service   = c.req.query("service");
  const hideEmpty = c.req.query("hideEmpty") === "true";
  const sortRaw = c.req.query("sort") ?? "recent";
  const sort: CollectionSort = (COLLECTION_SORT_VALUES as readonly string[]).includes(sortRaw)
    ? (sortRaw as CollectionSort)
    : "recent";

  const skip = (page - 1) * limit;

  // floor and volume are String? columns — need ::numeric cast via raw SQL
  if (sort === "floor" || sort === "volume") {
    const conditions: Prisma.Sql[] = [Prisma.sql`chain = 'STARKNET'`, Prisma.sql`"isHidden" = false`];
    if (isFeatured === "true")  conditions.push(Prisma.sql`"isFeatured" = true`);
    if (isFeatured === "false") conditions.push(Prisma.sql`"isFeatured" = false`);
    if (owner)     conditions.push(Prisma.sql`owner = ${normalizeAddress(owner)}`);
    if (service)   conditions.push(Prisma.sql`service = ${service}`);
    if (hideEmpty) conditions.push(Prisma.sql`"totalSupply" > 0`);
    const whereClause = Prisma.join(conditions, " AND ");

    const orderExpr = sort === "floor"
      ? Prisma.sql`"floorPrice"::numeric ASC NULLS LAST`
      : Prisma.sql`"totalVolume"::numeric DESC NULLS LAST`;

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<RawCollectionRow[]>`
        SELECT * FROM "Collection"
        WHERE ${whereClause}
        ORDER BY ${orderExpr}
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<RawCountRow[]>`
        SELECT COUNT(*) AS count FROM "Collection" WHERE ${whereClause}
      `,
    ]);

    return c.json({
      data:  data.map(serializeCollection),
      meta:  { page, limit, total: Number(rawTotal[0].count) },
    });
  }

  // ORM path for recent / supply / name
  const where: any = { chain: "STARKNET", isHidden: false };
  if (isFeatured === "true")  where.isFeatured = true;
  if (isFeatured === "false") where.isFeatured = false;
  if (owner)     where.owner = normalizeAddress(owner);
  if (service)   where.service = service;
  if (hideEmpty) where.totalSupply = { gt: 0 };

  const orderBy =
    sort === "supply" ? { totalSupply: "desc" as const } :
    sort === "name"   ? { name: "asc"  as const }        :
                        { createdAt: "desc" as const };  // "recent" — new default

  const [data, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: { profile: { select: { hasGatedContent: true, gatedContentTitle: true } } },
    }),
    prisma.collection.count({ where }),
  ]);

  return c.json({ data: data.map(serializeCollection), meta: { page, limit, total } });
});

// GET /v1/collections/by-slug/:slug — resolve a vanity slug to a full collection
collections.get("/by-slug/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase().trim();

  const profile = await prisma.collectionProfile.findUnique({
    where: { slug },
    select: { contractAddress: true, chain: true },
  });

  if (!profile) return c.json({ error: "Collection not found" }, 404);

  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: profile.chain, contractAddress: profile.contractAddress } },
    include: { profile: true },
  });

  if (!col || col.deletedAt) return c.json({ error: "Collection not found" }, 404);

  const { gatedContentUrl: _url, gatedContentType: _type, ...safeProfile } = col.profile as any;
  return c.json({ data: { ...serializeCollection(col), profile: safeProfile } });
});

// GET /v1/collections/:contract
collections.get("/:contract", async (c) => {
  const { contract } = c.req.param();
  const include = c.req.query("include");
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress(contract) } },
    ...(include === "profile" ? { include: { profile: true } } : {}),
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);

  let profileData: Record<string, unknown> | null = null;
  if (include === "profile") {
    const profile = (col as any).profile ?? null;
    if (profile) {
      // gatedContentUrl and gatedContentType are only returned to verified
      // token holders via GET /v1/collections/:contract/gated-content
      const { gatedContentUrl: _url, gatedContentType: _type, ...safeProfile } = profile;
      profileData = safeProfile;
    }
  }

  return c.json({
    data: {
      ...serializeCollection(col),
      ...(include === "profile" ? { profile: profileData } : {}),
    },
  });
});

// GET /v1/collections/:contract/tokens
collections.get("/:contract/tokens", async (c) => {
  const { contract } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const addr = normalizeAddress(contract);

  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: addr } },
  });

  if (collection) {
    const hiddenCreator = await prisma.hiddenCreator.findUnique({
      where: {
        chain_address: {
          chain: collection.chain,
          address: collection.owner ?? "",
        },
      },
    });
    if (hiddenCreator) {
      return c.json({ data: [], meta: { page, limit, total: 0 } });
    }
  }

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain: "STARKNET", contractAddress: addr, isHidden: false },
      orderBy: { tokenId: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { collection: { select: { standard: true } } },
    }),
    prisma.token.count({ where: { chain: "STARKNET", contractAddress: addr, isHidden: false } }),
  ]);

  return c.json({ data: data.map((t) => serializeToken(t, [])), meta: { page, limit, total } });
});

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
    const registryAddress = normalizeAddress(COLLECTION_721_CONTRACT);
    const events = (receipt as any).events ?? [];
    const collectionEvents = events.filter(
      (e: any) =>
        e.from_address &&
        normalizeAddress(e.from_address) === registryAddress &&
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

  const contractAddress = normalizeAddress(body.contractAddress);
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

  const collection = await prisma.collection.create({
    data: {
      chain: "STARKNET",
      contractAddress,
      startBlock,
      metadataStatus: "PENDING",
      standard: standard ?? "UNKNOWN",
      ...(service ? { service } : {}),
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

  const contractAddress = normalizeAddress(body.contractAddress);

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
      owner: body.owner ? normalizeAddress(body.owner) : null,
      standard: body.standard ?? "UNKNOWN",
      startBlock,
    },
    update: {
      name: body.name ?? undefined,
      symbol: body.symbol ?? undefined,
      description: body.description ?? undefined,
      image: body.image ?? undefined,
      baseUri: body.baseUri ?? undefined,
      owner: body.owner ? normalizeAddress(body.owner) : undefined,
      standard: body.standard ?? undefined,
    },
  });

  return c.json({ data: serializeCollection(col) }, 201);
});


function serializeCollection(c: any) {
  const profile = c.profile ?? null;
  return {
    id: c.id,
    chain: c.chain,
    contractAddress: c.contractAddress,
    collectionId: c.collectionId ?? null,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    image: c.image,
    owner: c.owner ?? null,
    startBlock: c.startBlock.toString(),
    metadataStatus: c.metadataStatus,
    standard: c.standard ?? "UNKNOWN",
    isFeatured: c.isFeatured,
    isHidden: c.isHidden,
    service: c.service ?? null,
    claimedBy: c.claimedBy ?? null,
    floorPrice: c.floorPrice,
    totalVolume: c.totalVolume,
    holderCount: c.holderCount,
    totalSupply: c.totalSupply,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    profile: profile
      ? { hasGatedContent: profile.hasGatedContent, gatedContentTitle: profile.gatedContentTitle ?? null, slug: profile.slug ?? null }
      : null,
  };
}

export default collections;
