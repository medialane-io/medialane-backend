import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../../config/env.js";
import { serializeToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";

const collections = new Hono();

// GET /v1/collections
collections.get("/", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const isKnown = c.req.query("isKnown");
  const owner = c.req.query("owner");

  const where: any = { chain: "STARKNET" };
  if (isKnown === "true") where.isKnown = true;
  else if (isKnown === "false") where.isKnown = false;
  if (owner) where.owner = normalizeAddress(owner);

  const [data, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      orderBy: { totalSupply: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.collection.count({ where }),
  ]);

  return c.json({ data: data.map(serializeCollection), meta: { page, limit, total } });
});

// GET /v1/collections/:contract
collections.get("/:contract", async (c) => {
  const { contract } = c.req.param();
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract.toLowerCase() } },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);
  return c.json({ data: serializeCollection(col) });
});

// GET /v1/collections/:contract/tokens
collections.get("/:contract/tokens", async (c) => {
  const { contract } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain: "STARKNET", contractAddress: contract.toLowerCase() },
      orderBy: { tokenId: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.token.count({ where: { chain: "STARKNET", contractAddress: contract.toLowerCase() } }),
  ]);

  return c.json({ data: data.map((t) => serializeToken(t, [])), meta: { page, limit, total } });
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

  const col = await prisma.collection.upsert({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: body.contractAddress.toLowerCase() } },
    create: {
      chain: "STARKNET",
      contractAddress: body.contractAddress.toLowerCase(),
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
