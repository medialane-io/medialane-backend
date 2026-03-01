import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import type { OrderStatus } from "@prisma/client";

const orders = new Hono();

const listQuerySchema = z.object({
  status: z.enum(["ACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"]).optional(),
  collection: z.string().optional(),
  currency: z.string().optional(),
  sort: z.enum(["price_asc", "price_desc", "recent"]).default("recent"),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  offerer: z.string().optional(),
});

// GET /v1/orders
orders.get("/", async (c) => {
  const query = listQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    return c.json({ error: "Invalid query", details: query.error.flatten() }, 400);
  }

  const { status, collection, currency, sort, page, limit, offerer } =
    query.data;

  const skip = (page - 1) * limit;

  // Price sorts require numeric ordering — priceRaw is a text column, so we cast
  // to numeric via raw SQL (length+lex trick works too, but ::numeric is cleaner).
  if (sort === "price_asc" || sort === "price_desc") {
    const dir = Prisma.raw(sort === "price_asc" ? "ASC" : "DESC");
    const conditions: Prisma.Sql[] = [Prisma.sql`chain = 'STARKNET'`];
    if (status) conditions.push(Prisma.sql`status = ${status}`);
    if (collection) conditions.push(Prisma.sql`"nftContract" = ${collection.toLowerCase()}`);
    if (currency) conditions.push(Prisma.sql`"considerationToken" = ${currency.toLowerCase()}`);
    if (offerer) conditions.push(Prisma.sql`offerer = ${offerer.toLowerCase()}`);
    const whereClause = Prisma.join(conditions, " AND ");

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<any[]>`
        SELECT * FROM "Order"
        WHERE ${whereClause}
        ORDER BY "priceRaw"::numeric ${dir} NULLS LAST
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count FROM "Order" WHERE ${whereClause}
      `,
    ]);

    return c.json({
      data: data.map(serializeOrder),
      meta: { page, limit, total: Number(rawTotal[0].count) },
    });
  }

  // Default: recent sort via Prisma ORM
  const where: any = { chain: "STARKNET" };
  if (status) where.status = status as OrderStatus;
  if (collection) where.nftContract = collection.toLowerCase();
  if (currency) where.considerationToken = currency.toLowerCase();
  if (offerer) where.offerer = offerer.toLowerCase();

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);

  return c.json({
    data: data.map(serializeOrder),
    meta: { page, limit, total },
  });
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
  const data = await prisma.order.findMany({
    where: {
      chain: "STARKNET",
      nftContract: contract.toLowerCase(),
      nftTokenId: tokenId,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
  });
  return c.json({ data: data.map(serializeOrder) });
});

// GET /v1/orders/user/:address
orders.get("/user/:address", async (c) => {
  const { address } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where: { chain: "STARKNET", offerer: address.toLowerCase() },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: { chain: "STARKNET", offerer: address.toLowerCase() } }),
  ]);

  return c.json({ data: data.map(serializeOrder), meta: { page, limit, total } });
});

function serializeOrder(o: any) {
  return {
    id: o.id,
    chain: o.chain,
    orderHash: o.orderHash,
    offerer: o.offerer,
    offer: {
      itemType: o.offerItemType,
      token: o.offerToken,
      identifier: o.offerIdentifier,
      startAmount: o.offerStartAmount,
      endAmount: o.offerEndAmount,
    },
    consideration: {
      itemType: o.considerationItemType,
      token: o.considerationToken,
      identifier: o.considerationIdentifier,
      startAmount: o.considerationStartAmount,
      endAmount: o.considerationEndAmount,
      recipient: o.considerationRecipient,
    },
    startTime: o.startTime.toString(),
    endTime: o.endTime.toString(),
    status: o.status,
    fulfiller: o.fulfiller,
    nftContract: o.nftContract,
    nftTokenId: o.nftTokenId,
    price: {
      raw: o.priceRaw,
      formatted: o.priceFormatted,
      currency: o.currencySymbol,
    },
    txHash: {
      created: o.createdTxHash,
      fulfilled: o.fulfilledTxHash,
      cancelled: o.cancelledTxHash,
    },
    createdBlockNumber: o.createdBlockNumber.toString(),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export default orders;
