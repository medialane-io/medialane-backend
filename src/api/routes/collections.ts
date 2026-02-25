import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../../config/env.js";

const collections = new Hono();

// GET /v1/collections
collections.get("/", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  const [data, total] = await Promise.all([
    prisma.collection.findMany({
      orderBy: { totalSupply: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.collection.count(),
  ]);

  return c.json({ data: data.map(serializeCollection), meta: { page, limit, total } });
});

// GET /v1/collections/:contract
collections.get("/:contract", async (c) => {
  const { contract } = c.req.param();
  const col = await prisma.collection.findUnique({
    where: { contractAddress: contract.toLowerCase() },
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
      where: { contractAddress: contract.toLowerCase() },
      orderBy: { tokenId: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.token.count({ where: { contractAddress: contract.toLowerCase() } }),
  ]);

  return c.json({ data, meta: { page, limit, total } });
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
    where: { contractAddress: body.contractAddress.toLowerCase() },
    create: {
      contractAddress: body.contractAddress.toLowerCase(),
      name: body.name ?? null,
      startBlock,
      isKnown: true,
    },
    update: {
      name: body.name ?? undefined,
      isKnown: true,
    },
  });

  return c.json({ data: serializeCollection(col) }, 201);
});

function serializeCollection(c: any) {
  return {
    id: c.id,
    contractAddress: c.contractAddress,
    name: c.name,
    startBlock: c.startBlock.toString(),
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
