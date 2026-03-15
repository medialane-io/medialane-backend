import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import type { OrderStatus } from "@prisma/client";
import { serializeOrder, batchTokenMeta } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { RawOrderRow, RawCountRow } from "../utils/rawTypes.js";

const orders = new Hono();

const listQuerySchema = z.object({
  status: z.enum(["ACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"]).optional(),
  collection: z.string().optional(),
  currency: z.string().optional(),
  sort: z.enum(["price_asc", "price_desc", "recent"]).default("recent"),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  offerer: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
}).refine(
  (data) => {
    if (data.minPrice !== undefined && data.maxPrice !== undefined) {
      try {
        return BigInt(data.minPrice) <= BigInt(data.maxPrice);
      } catch {
        return false;
      }
    }
    return true;
  },
  { message: "minPrice must be less than or equal to maxPrice", path: ["minPrice"] }
);

// GET /v1/orders
orders.get("/", async (c) => {
  const query = listQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    return c.json({ error: "Invalid query", details: query.error.flatten() }, 400);
  }

  const { status, collection, currency, sort, page, limit, offerer, minPrice, maxPrice } =
    query.data;

  const skip = (page - 1) * limit;

  // Pre-fetch hidden contracts for price-sort path guards
  const hiddenCollections = await prisma.collection.findMany({
    where: { isHidden: true },
    select: { contractAddress: true },
  });
  const hiddenContracts = hiddenCollections.map((c) => c.contractAddress);

  // Price sorts require numeric ordering — priceRaw is a text column, so we cast
  // to numeric via raw SQL (length+lex trick works too, but ::numeric is cleaner).
  if (sort === "price_asc" || sort === "price_desc") {
    const dir = Prisma.raw(sort === "price_asc" ? "ASC" : "DESC");
    const conditions: Prisma.Sql[] = [Prisma.sql`chain = 'STARKNET'`];
    if (status) conditions.push(Prisma.sql`status = ${status}`);
    if (collection) conditions.push(Prisma.sql`"nftContract" = ${collection.toLowerCase()}`);
    if (currency) conditions.push(Prisma.sql`"considerationToken" = ${currency.toLowerCase()}`);
    if (offerer) conditions.push(Prisma.sql`offerer = ${normalizeAddress(offerer)}`);
    if (minPrice) conditions.push(Prisma.sql`"priceRaw"::numeric >= ${minPrice}::numeric`);
    if (maxPrice) conditions.push(Prisma.sql`"priceRaw"::numeric <= ${maxPrice}::numeric`);
    if (hiddenContracts.length > 0) {
      conditions.push(Prisma.sql`"nftContract" NOT IN (SELECT "contractAddress" FROM "Collection" WHERE "isHidden" = true)`);
      conditions.push(Prisma.sql`NOT ("nftContract", "nftTokenId") IN (SELECT "contractAddress", "tokenId" FROM "Token" WHERE "isHidden" = true)`);
    }
    const whereClause = Prisma.join(conditions, " AND ");

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<RawOrderRow[]>`
        SELECT * FROM "Order"
        WHERE ${whereClause}
        ORDER BY "priceRaw"::numeric ${dir} NULLS LAST
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<RawCountRow[]>`
        SELECT COUNT(*) AS count FROM "Order" WHERE ${whereClause}
      `,
    ]);

    const tokenMeta = await batchTokenMeta(data);
    return c.json({
      data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))),
      meta: { page, limit, total: Number(rawTotal[0].count) },
    });
  }

  // Default: recent sort via Prisma ORM
  // Price range filters require raw SQL even here since priceRaw is a text column
  if ((minPrice || maxPrice) && sort === "recent") {
    const conditions: Prisma.Sql[] = [Prisma.sql`chain = 'STARKNET'`];
    if (status) conditions.push(Prisma.sql`status = ${status}`);
    if (collection) conditions.push(Prisma.sql`"nftContract" = ${collection.toLowerCase()}`);
    if (currency) conditions.push(Prisma.sql`"considerationToken" = ${currency.toLowerCase()}`);
    if (offerer) conditions.push(Prisma.sql`offerer = ${normalizeAddress(offerer)}`);
    if (minPrice) conditions.push(Prisma.sql`"priceRaw"::numeric >= ${minPrice}::numeric`);
    if (maxPrice) conditions.push(Prisma.sql`"priceRaw"::numeric <= ${maxPrice}::numeric`);
    if (hiddenContracts.length > 0) {
      conditions.push(Prisma.sql`"nftContract" NOT IN (SELECT "contractAddress" FROM "Collection" WHERE "isHidden" = true)`);
      conditions.push(Prisma.sql`NOT ("nftContract", "nftTokenId") IN (SELECT "contractAddress", "tokenId" FROM "Token" WHERE "isHidden" = true)`);
    }
    const whereClause = Prisma.join(conditions, " AND ");

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<RawOrderRow[]>`
        SELECT * FROM "Order" WHERE ${whereClause}
        ORDER BY "createdAt" DESC LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<RawCountRow[]>`
        SELECT COUNT(*) AS count FROM "Order" WHERE ${whereClause}
      `,
    ]);

    const tokenMeta = await batchTokenMeta(data);
    return c.json({
      data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))),
      meta: { page, limit, total: Number(rawTotal[0].count) },
    });
  }

  // Default: recent sort via $queryRaw to apply hidden-token filtering at DB level,
  // preventing pagination drift and total overcounting when hidden tokens exist.
  {
    const conditions: Prisma.Sql[] = [Prisma.sql`chain = 'STARKNET'`];
    if (status) conditions.push(Prisma.sql`status = ${status}`);
    if (collection) conditions.push(Prisma.sql`"nftContract" = ${collection.toLowerCase()}`);
    if (currency) conditions.push(Prisma.sql`"considerationToken" = ${currency.toLowerCase()}`);
    if (offerer) conditions.push(Prisma.sql`offerer = ${normalizeAddress(offerer)}`);
    conditions.push(Prisma.sql`"nftContract" NOT IN (SELECT "contractAddress" FROM "Collection" WHERE "isHidden" = true)`);
    conditions.push(Prisma.sql`NOT ("nftContract", "nftTokenId") IN (SELECT "contractAddress", "tokenId" FROM "Token" WHERE "isHidden" = true)`);
    const whereClause = Prisma.join(conditions, " AND ");

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<RawOrderRow[]>`
        SELECT * FROM "Order"
        WHERE ${whereClause}
        ORDER BY "createdAt" DESC
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<RawCountRow[]>`
        SELECT COUNT(*) AS count FROM "Order" WHERE ${whereClause}
      `,
    ]);

    const tokenMeta = await batchTokenMeta(data);
    return c.json({
      data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))),
      meta: { page, limit, total: Number(rawTotal[0].count) },
    });
  }
});

// GET /v1/orders/:orderHash
orders.get("/:orderHash", async (c) => {
  const { orderHash } = c.req.param();
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash } },
  });
  if (!order) return c.json({ error: "Order not found" }, 404);
  return c.json({ data: serializeOrder(order) });
});

// GET /v1/orders/token/:contract/:tokenId
orders.get("/token/:contract/:tokenId", async (c) => {
  const { contract, tokenId } = c.req.param();
  const normalizedContract = normalizeAddress(contract);

  const [hiddenToken, hiddenCollection] = await Promise.all([
    prisma.token.findFirst({
      where: { contractAddress: normalizedContract, tokenId, isHidden: true },
      select: { tokenId: true },
    }),
    prisma.collection.findFirst({
      where: { contractAddress: normalizedContract, isHidden: true },
      select: { contractAddress: true },
    }),
  ]);
  if (hiddenToken || hiddenCollection) {
    return c.json({ data: [] });
  }

  const data = await prisma.order.findMany({
    where: {
      chain: "STARKNET",
      nftContract: normalizedContract,
      nftTokenId: tokenId,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
  });
  const tokenMeta = await batchTokenMeta(data);
  return c.json({ data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))) });
});

// GET /v1/orders/user/:address
orders.get("/user/:address", async (c) => {
  const { address } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where: { chain: "STARKNET", offerer: normalizeAddress(address) },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: { chain: "STARKNET", offerer: normalizeAddress(address) } }),
  ]);

  const tokenMeta = await batchTokenMeta(data);
  return c.json({ data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))), meta: { page, limit, total } });
});

export default orders;
