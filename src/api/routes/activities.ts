import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";

const activities = new Hono();

/** Classify a Transfer row as "mint" (fromAddress is zero) or "transfer". */
function transferType(fromAddress: string): "mint" | "transfer" {
  return fromAddress === ZERO_ADDRESS ? "mint" : "transfer";
}

// GET /v1/activities
activities.get("/", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const type = c.req.query("type");

  const skip = (page - 1) * limit;

  // Two cheap indexed lookups — skip full hidden-list fetch when nothing is hidden
  const [anyHiddenCollection, anyHiddenToken] = await Promise.all([
    prisma.collection.findFirst({ where: { isHidden: true }, select: { contractAddress: true } }),
    prisma.token.findFirst({ where: { isHidden: true }, select: { contractAddress: true } }),
  ]);

  const hiddenContracts: string[] = [];
  const hiddenTokenSet = new Set<string>();

  if (anyHiddenCollection || anyHiddenToken) {
    const [hiddenCols, hiddenToks] = await Promise.all([
      anyHiddenCollection
        ? prisma.collection.findMany({ where: { isHidden: true }, select: { contractAddress: true } })
        : [],
      anyHiddenToken
        ? prisma.token.findMany({
            where: { isHidden: true },
            select: { contractAddress: true, tokenId: true },
          })
        : [],
    ]);
    hiddenContracts.push(...hiddenCols.map((c) => c.contractAddress));
    hiddenToks.forEach((t) => hiddenTokenSet.add(`${t.contractAddress}:${t.tokenId}`));
  }

  const hiddenContractFilter =
    hiddenContracts.length > 0 ? { notIn: hiddenContracts } : undefined;

  // "mint" and "transfer" both come from the Transfer table; mints have fromAddress = ZERO_ADDRESS
  const wantTransfers = !type || type === "transfer" || type === "mint";
  const wantOrders = !type || ["sale", "listing", "offer", "cancelled"].includes(type);

  const orderStatusFilter =
    type === "sale"
      ? { status: "FULFILLED" as const }
      : type === "listing"
      ? { status: "ACTIVE" as const, offerItemType: "ERC721" as const }
      : type === "cancelled"
      ? { status: "CANCELLED" as const }
      : type === "offer"
      ? { offerItemType: "ERC20" as const, status: "ACTIVE" as const }
      : {};

  const transferWhere: any = { chain: "STARKNET" };
  if (type === "mint") transferWhere.fromAddress = ZERO_ADDRESS;
  if (type === "transfer") transferWhere.fromAddress = { not: ZERO_ADDRESS };
  if (hiddenContractFilter) transferWhere.contractAddress = hiddenContractFilter;

  const orderWhere: any = { chain: "STARKNET", ...orderStatusFilter };
  if (hiddenContractFilter) orderWhere.nftContract = hiddenContractFilter;

  const [transfers, orders, transferCount, orderCount] = await Promise.all([
    wantTransfers
      ? prisma.transfer.findMany({
          where: transferWhere,
          orderBy: { blockNumber: "desc" },
          skip,
          take: limit,
        })
      : [],
    wantOrders
      ? prisma.order.findMany({
          where: orderWhere,
          orderBy: { updatedAt: "desc" },
          skip,
          take: limit,
        })
      : [],
    wantTransfers ? prisma.transfer.count({ where: transferWhere }) : 0,
    wantOrders ? prisma.order.count({ where: orderWhere }) : 0,
  ]);

  // Collect txHashes of fulfilled orders so we can suppress the redundant Transfer
  // row that the marketplace contract emits during a sale (same tx, misleading type).
  const saleTxHashes = new Set(
    (orders as any[])
      .filter((o) => o.status === "FULFILLED" && o.createdTxHash)
      .map((o) => o.createdTxHash as string)
  );

  const rawFeed = [
    ...(transfers as any[])
      .filter((t) => !saleTxHashes.has(t.txHash)) // suppress transfer rows that belong to a sale
      .map((t) => ({
        type: transferType(t.fromAddress),
        contractAddress: t.contractAddress,
        tokenId: t.tokenId,
        from: t.fromAddress === ZERO_ADDRESS ? null : t.fromAddress,
        to: t.toAddress,
        blockNumber: t.blockNumber.toString(),
        txHash: t.txHash,
        timestamp: t.createdAt,
      })),
    ...(orders as any[]).map((o) => ({
      type:
        o.status === "FULFILLED"
          ? "sale"
          : o.status === "ACTIVE" && o.offerItemType === "ERC20"
          ? "offer"
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

  const feed =
    hiddenTokenSet.size > 0
      ? rawFeed.filter((item) => {
          const contract = (item as any).contractAddress ?? (item as any).nftContract;
          const tokenId = (item as any).tokenId ?? (item as any).nftTokenId;
          return !hiddenTokenSet.has(`${contract}:${tokenId}`);
        })
      : rawFeed;

  return c.json({ data: feed, meta: { page, limit, total: transferCount + orderCount } });
});

// GET /v1/activities/:address
activities.get("/:address", async (c) => {
  const { address } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const skip = (page - 1) * limit;
  const addr = normalizeAddress(address);

  // Two cheap indexed lookups — skip full hidden-list fetch when nothing is hidden
  const [anyHiddenCollection, anyHiddenToken] = await Promise.all([
    prisma.collection.findFirst({ where: { isHidden: true }, select: { contractAddress: true } }),
    prisma.token.findFirst({ where: { isHidden: true }, select: { contractAddress: true } }),
  ]);

  const hiddenContracts: string[] = [];
  const hiddenTokenSet = new Set<string>();

  if (anyHiddenCollection || anyHiddenToken) {
    const [hiddenCols, hiddenToks] = await Promise.all([
      anyHiddenCollection
        ? prisma.collection.findMany({ where: { isHidden: true }, select: { contractAddress: true } })
        : [],
      anyHiddenToken
        ? prisma.token.findMany({
            where: { isHidden: true },
            select: { contractAddress: true, tokenId: true },
          })
        : [],
    ]);
    hiddenContracts.push(...hiddenCols.map((c) => c.contractAddress));
    hiddenToks.forEach((t) => hiddenTokenSet.add(`${t.contractAddress}:${t.tokenId}`));
  }

  const hiddenContractFilter =
    hiddenContracts.length > 0 ? { notIn: hiddenContracts } : undefined;

  const transferWhere: any = {
    chain: "STARKNET",
    OR: [{ fromAddress: addr }, { toAddress: addr }],
  };
  if (hiddenContractFilter) transferWhere.contractAddress = hiddenContractFilter;

  const orderWhere: any = { chain: "STARKNET", OR: [{ offerer: addr }, { fulfiller: addr }] };
  if (hiddenContractFilter) orderWhere.nftContract = hiddenContractFilter;

  const [transfers, orders] = await Promise.all([
    prisma.transfer.findMany({
      where: transferWhere,
      orderBy: { blockNumber: "desc" },
      skip,
      take: limit,
    }),
    prisma.order.findMany({
      where: orderWhere,
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  // Suppress transfer rows that are part of a fulfilled sale
  const saleTxHashes = new Set(
    orders
      .filter((o) => o.status === "FULFILLED" && o.createdTxHash)
      .map((o) => o.createdTxHash as string)
  );

  const rawFeed = [
    ...transfers
      .filter((t) => !saleTxHashes.has(t.txHash))
      .map((t) => ({
        type: transferType(t.fromAddress),
        contractAddress: t.contractAddress,
        tokenId: t.tokenId,
        from: t.fromAddress === ZERO_ADDRESS ? null : t.fromAddress,
        to: t.toAddress,
        blockNumber: t.blockNumber.toString(),
        txHash: t.txHash,
        timestamp: t.createdAt,
      })),
    ...orders.map((o) => ({
      type:
        o.status === "FULFILLED"
          ? "sale"
          : o.status === "ACTIVE" && o.offerItemType === "ERC20"
          ? "offer"
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

  const feed =
    hiddenTokenSet.size > 0
      ? rawFeed.filter((item) => {
          const contract = (item as any).contractAddress ?? (item as any).nftContract;
          const tokenId = (item as any).tokenId ?? (item as any).nftTokenId;
          return !hiddenTokenSet.has(`${contract}:${tokenId}`);
        })
      : rawFeed;

  return c.json({ data: feed, meta: { page, limit } });
});

export default activities;
