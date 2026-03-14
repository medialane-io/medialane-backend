import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { RawCollectionRow, RawCountRow } from "../utils/rawTypes.js";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../../config/env.js";
import { serializeToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { RpcProvider, num as starkNum } from "starknet";
import { COLLECTION_CONTRACT, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { resolveCollectionCreated } from "../../mirror/handlers/collectionCreated.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:collections");

const collections = new Hono();

// Valid sort values for GET /v1/collections
const COLLECTION_SORT_VALUES = ["recent", "supply", "floor", "volume", "name"] as const;
type CollectionSort = (typeof COLLECTION_SORT_VALUES)[number];

// GET /v1/collections
collections.get("/", async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const isKnown = c.req.query("isKnown");
  const owner   = c.req.query("owner");
  const sortRaw = c.req.query("sort") ?? "recent";
  const sort: CollectionSort = (COLLECTION_SORT_VALUES as readonly string[]).includes(sortRaw)
    ? (sortRaw as CollectionSort)
    : "recent";

  const skip = (page - 1) * limit;

  // floor and volume are String? columns — need ::numeric cast via raw SQL
  if (sort === "floor" || sort === "volume") {
    const conditions: Prisma.Sql[] = [Prisma.sql`chain = 'STARKNET'`];
    if (isKnown === "true")  conditions.push(Prisma.sql`"isKnown" = true`);
    if (isKnown === "false") conditions.push(Prisma.sql`"isKnown" = false`);
    if (owner) conditions.push(Prisma.sql`owner = ${normalizeAddress(owner)}`);
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
  const where: any = { chain: "STARKNET" };
  if (isKnown === "true")  where.isKnown = true;
  if (isKnown === "false") where.isKnown = false;
  if (owner) where.owner = normalizeAddress(owner);

  const orderBy =
    sort === "supply" ? { totalSupply: "desc" as const } :
    sort === "name"   ? { name: "asc"  as const }        :
                        { createdAt: "desc" as const };  // "recent" — new default

  const [data, total] = await Promise.all([
    prisma.collection.findMany({ where, orderBy, skip, take: limit }),
    prisma.collection.count({ where }),
  ]);

  return c.json({ data: data.map(serializeCollection), meta: { page, limit, total } });
});

// GET /v1/collections/:contract
collections.get("/:contract", async (c) => {
  const { contract } = c.req.param();
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress(contract) } },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);
  return c.json({ data: serializeCollection(col) });
});

// GET /v1/collections/:contract/tokens
collections.get("/:contract/tokens", async (c) => {
  const { contract } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const addr = normalizeAddress(contract);

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain: "STARKNET", contractAddress: addr },
      orderBy: { tokenId: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.token.count({ where: { chain: "STARKNET", contractAddress: addr } }),
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
    const provider = new RpcProvider({ nodeUrl: env.ALCHEMY_RPC_URL });
    const receipt = await provider.getTransactionReceipt(txHash);

    const collectionCreatedKey = starkNum.toHex(COLLECTION_CREATED_SELECTOR);
    const events = (receipt as any).events ?? [];
    const collectionEvents = events.filter(
      (e: any) =>
        e.from_address?.toLowerCase() === COLLECTION_CONTRACT.toLowerCase() &&
        e.keys?.[0] && starkNum.toHex(e.keys[0]) === collectionCreatedKey
    );

    if (collectionEvents.length === 0) {
      return c.json({ data: { synced: 0, message: "No CollectionCreated event found in this transaction" } });
    }

    let synced = 0;
    for (const event of collectionEvents) {
      const data = event.data;
      if (!data || data.length < 3) continue;
      const collectionId = (BigInt(data[0]) + (BigInt(data[1]) << 128n)).toString();
      const owner = normalizeAddress(data[2]);
      const blockNumber = BigInt(event.block_number ?? 0);

      const resolved = await resolveCollectionCreated({
        type: "CollectionCreated",
        collectionId,
        owner,
        blockNumber,
        txHash,
        logIndex: 0,
      });
      if (!resolved) continue;

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
          metadataStatus: "PENDING",
        },
        update: {
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          owner: resolved.owner,
        },
      });

      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: resolved.contractAddress });
      synced++;
      log.info({ txHash, contractAddress: resolved.contractAddress, owner }, "Collection synced from tx");
    }

    return c.json({ data: { synced } });
  } catch (err) {
    log.error({ err, txHash }, "sync-tx failed");
    return c.json({ error: String(err) }, 500);
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

  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (existing) {
    return c.json({ data: serializeCollection(existing) });
  }

  const collection = await prisma.collection.create({
    data: {
      chain: "STARKNET",
      contractAddress,
      startBlock,
      metadataStatus: "PENDING",
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
      startBlock,
      isKnown: true,
    },
    update: {
      name: body.name ?? undefined,
      symbol: body.symbol ?? undefined,
      description: body.description ?? undefined,
      image: body.image ?? undefined,
      isKnown: true,
    },
  });

  return c.json({ data: serializeCollection(col) }, 201);
});


function serializeCollection(c: any) {
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
    isKnown: c.isKnown,
    floorPrice: c.floorPrice,
    totalVolume: c.totalVolume,
    holderCount: c.holderCount,
    totalSupply: c.totalSupply,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export default collections;
