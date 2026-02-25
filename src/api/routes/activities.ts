import { Hono } from "hono";
import prisma from "../../db/client.js";

const activities = new Hono();

// GET /v1/activities
activities.get("/", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const type = c.req.query("type");

  const skip = (page - 1) * limit;

  // Mix transfers and order activities
  const [transfers, orders] = await Promise.all([
    !type || type === "transfer"
      ? prisma.transfer.findMany({
          orderBy: { blockNumber: "desc" },
          skip,
          take: limit,
        })
      : [],
    !type || ["sale", "listing", "offer"].includes(type)
      ? prisma.order.findMany({
          where: type === "sale"
            ? { status: "FULFILLED" }
            : type === "listing"
            ? { status: "ACTIVE" }
            : {},
          orderBy: { updatedAt: "desc" },
          skip,
          take: limit,
        })
      : [],
  ]);

  const feed = [
    ...(transfers as any[]).map((t) => ({
      type: "transfer",
      contractAddress: t.contractAddress,
      tokenId: t.tokenId,
      from: t.fromAddress,
      to: t.toAddress,
      blockNumber: t.blockNumber.toString(),
      txHash: t.txHash,
      timestamp: t.createdAt,
    })),
    ...(orders as any[]).map((o) => ({
      type:
        o.status === "FULFILLED"
          ? "sale"
          : o.status === "ACTIVE"
          ? "listing"
          : "cancelled",
      orderHash: o.orderHash,
      nftContract: o.nftContract,
      nftTokenId: o.nftTokenId,
      offerer: o.offerer,
      fulfiller: o.fulfiller,
      price: { raw: o.priceRaw, formatted: o.priceFormatted, currency: o.currencySymbol },
      txHash: o.createdTxHash,
      timestamp: o.updatedAt,
    })),
  ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return c.json({ data: feed, meta: { page, limit } });
});

// GET /v1/activities/:address
activities.get("/:address", async (c) => {
  const { address } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const skip = (page - 1) * limit;
  const addr = address.toLowerCase();

  const [transfers, orders] = await Promise.all([
    prisma.transfer.findMany({
      where: { OR: [{ fromAddress: addr }, { toAddress: addr }] },
      orderBy: { blockNumber: "desc" },
      skip,
      take: limit,
    }),
    prisma.order.findMany({
      where: { OR: [{ offerer: addr }, { fulfiller: addr }] },
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  const feed = [
    ...transfers.map((t) => ({
      type: "transfer",
      contractAddress: t.contractAddress,
      tokenId: t.tokenId,
      from: t.fromAddress,
      to: t.toAddress,
      blockNumber: t.blockNumber.toString(),
      txHash: t.txHash,
      timestamp: t.createdAt,
    })),
    ...orders.map((o) => ({
      type:
        o.status === "FULFILLED"
          ? "sale"
          : o.status === "ACTIVE"
          ? "listing"
          : "cancelled",
      orderHash: o.orderHash,
      nftContract: o.nftContract,
      nftTokenId: o.nftTokenId,
      offerer: o.offerer,
      fulfiller: o.fulfiller,
      price: { raw: o.priceRaw, formatted: o.priceFormatted, currency: o.currencySymbol },
      txHash: o.createdTxHash,
      timestamp: o.updatedAt,
    })),
  ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return c.json({ data: feed, meta: { page, limit } });
});

export default activities;
