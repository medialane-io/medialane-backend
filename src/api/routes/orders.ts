import { Hono } from "hono";
import { z } from "zod";
import { parseSingleChain, parseChainFilter } from "../utils/chainFilter.js";
import { Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import type { OrderStatus } from "@prisma/client";
import { serializeOrder, batchTokenMeta, counterOfferFlags } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { RawOrderRow, RawCountRow } from "../utils/rawTypes.js";

const orders = new Hono();

// ---------------------------------------------------------------------------
// Shared condition builder — used by all three $queryRaw branches in GET /
// ---------------------------------------------------------------------------
interface OrderFilterParams {
  chainFilter: { chain: import("@prisma/client").Chain } | "all";
  status?: string;
  collection?: string;
  currency?: string;
  offerer?: string;
  minPrice?: string;
  maxPrice?: string;
}

function buildOrderConditions(params: OrderFilterParams): Prisma.Sql[] {
  const { chainFilter, status, collection, currency, offerer, minPrice, maxPrice } = params;
  const conditions: Prisma.Sql[] =
    chainFilter === "all" ? [] : [Prisma.sql`chain = ${chainFilter.chain}::"Chain"`];
  if (status) conditions.push(Prisma.sql`status = ${status}::"OrderStatus"`);
  if (collection) conditions.push(Prisma.sql`"nftContract" = ${collection.toLowerCase()}`);
  if (currency) conditions.push(Prisma.sql`"considerationToken" = ${currency.toLowerCase()}`);
  if (offerer) conditions.push(Prisma.sql`offerer = ${normalizeAddress(chainFilter === "all" ? "STARKNET" : chainFilter.chain, offerer)}`);
  if (minPrice) conditions.push(Prisma.sql`"priceRaw"::numeric >= ${minPrice}::numeric`);
  if (maxPrice) conditions.push(Prisma.sql`"priceRaw"::numeric <= ${maxPrice}::numeric`);
  conditions.push(Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "Collection"
  WHERE "contractAddress" = "Order"."nftContract" AND "isHidden" = true
)`);
  conditions.push(Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "Token"
  WHERE "contractAddress" = "Order"."nftContract"
    AND "tokenId" = "Order"."nftTokenId"
    AND "isHidden" = true
)`);
  return conditions;
}

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
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  if (offerer && chainFilter === "all") {
    return c.json({ error: "offerer filter requires a single chain" }, 400);
  }

  const skip = (page - 1) * limit;

  const whereClause = Prisma.join(
    buildOrderConditions({ chainFilter, status, collection, currency, offerer, minPrice, maxPrice }),
    " AND "
  );

  let orderBy: Prisma.Sql;
  if (sort === "price_asc") {
    orderBy = Prisma.sql`"priceRaw"::numeric ASC NULLS LAST`;
  } else if (sort === "price_desc") {
    orderBy = Prisma.sql`"priceRaw"::numeric DESC NULLS LAST`;
  } else {
    orderBy = Prisma.sql`"createdAt" DESC`;
  }

  const [data, rawTotal] = await Promise.all([
    prisma.$queryRaw<RawOrderRow[]>`
      SELECT * FROM "Order"
      WHERE ${whereClause}
      ORDER BY ${orderBy}
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
});

// GET /v1/orders/counter-offers
// ?originalOrderHash=<hash>  — the counter-offer order for a specific bid (buyer view)
// ?sellerAddress=<addr>       — all counter-offers sent by a seller
orders.get("/counter-offers", async (c) => {
  const originalOrderHash = c.req.query("originalOrderHash");
  const sellerAddress = c.req.query("sellerAddress");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));

  if (!originalOrderHash && !sellerAddress) {
    return c.json({ error: "originalOrderHash or sellerAddress is required" }, 400);
  }

  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const where: Record<string, unknown> = { chain, parentOrderHash: { not: null } };
  if (originalOrderHash) where.parentOrderHash = originalOrderHash;
  if (sellerAddress) where.offerer = normalizeAddress(chain, sellerAddress);

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where: where as any,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: where as any }),
  ]);

  const tokenMeta = await batchTokenMeta(data);
  return c.json({
    data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))),
    meta: { page, limit, total },
  });
});

// GET /v1/orders/:orderHash
orders.get("/:orderHash", async (c) => {
  const { orderHash } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain, orderHash } },
  });
  if (!order) return c.json({ error: "Order not found" }, 404);
  const counterFlags = await counterOfferFlags(prisma, [order]);
  return c.json({ data: serializeOrder(order, undefined, counterFlags.has(order.orderHash)) });
});

// GET /v1/orders/token/:contract/:tokenId
orders.get("/token/:contract/:tokenId", async (c) => {
  const { contract, tokenId } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const normalizedContract = normalizeAddress(chain, contract);

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
      chain,
      nftContract: normalizedContract,
      nftTokenId: tokenId,
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
  });
  const tokenMeta = await batchTokenMeta(data);
  return c.json({ data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))) });
});

// GET /v1/orders/received/:address — active ERC20 offers on tokens the address currently holds
orders.get("/received/:address", async (c) => {
  const { address } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const page = Number(c.req.query("page") ?? 1);
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const normalizedAddress = normalizeAddress(chain, address);
  const offset = (page - 1) * limit;

  const [data, countRows] = await Promise.all([
    prisma.$queryRaw<RawOrderRow[]>`
      SELECT o.*
      FROM "Order" o
      JOIN "TokenBalance" tb
        ON tb.chain = ${chain}::"Chain"
        AND tb."contractAddress" = o."nftContract"
        AND tb."tokenId" = o."nftTokenId"
        AND tb.owner = ${normalizedAddress}
        AND tb.amount::numeric > 0
      WHERE o.chain = ${chain}::"Chain"
        AND o."offerItemType" = 'ERC20'
        AND o.status = 'ACTIVE'::"OrderStatus"
        AND o."nftContract" IS NOT NULL
        AND o."nftTokenId" IS NOT NULL
      ORDER BY o."createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    prisma.$queryRaw<RawCountRow[]>`
      SELECT COUNT(o.id)::bigint AS count
      FROM "Order" o
      JOIN "TokenBalance" tb
        ON tb.chain = ${chain}::"Chain"
        AND tb."contractAddress" = o."nftContract"
        AND tb."tokenId" = o."nftTokenId"
        AND tb.owner = ${normalizedAddress}
        AND tb.amount::numeric > 0
      WHERE o.chain = ${chain}::"Chain"
        AND o."offerItemType" = 'ERC20'
        AND o.status = 'ACTIVE'::"OrderStatus"
        AND o."nftContract" IS NOT NULL
        AND o."nftTokenId" IS NOT NULL
    `,
  ]);

  const tokenMeta = await batchTokenMeta(data);
  return c.json({
    data: data.map((o) => serializeOrder(o, tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`))),
    meta: { page, limit, total: Number(countRows[0]?.count ?? 0) },
  });
});

// GET /v1/orders/user/:address
orders.get("/user/:address", async (c) => {
  const { address } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const offererAddr = normalizeAddress(chain, address);

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where: { chain, offerer: offererAddr },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: { chain, offerer: offererAddr } }),
  ]);

  const [tokenMeta, counterFlags] = await Promise.all([
    batchTokenMeta(data),
    counterOfferFlags(prisma, data),
  ]);
  return c.json({
    data: data.map((o) =>
      serializeOrder(
        o,
        tokenMeta.get(`${o.nftContract}-${o.nftTokenId}`),
        counterFlags.has(o.orderHash),
      ),
    ),
    meta: { page, limit, total },
  });
});

export default orders;
