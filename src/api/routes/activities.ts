import { Hono } from "hono";
import { Prisma, type Chain } from "@prisma/client";
import { publicCache } from "../middleware/publicCache.js";
import { parseSingleChain, chainWhere, parseChainFilter } from "../utils/chainFilter.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import {
  ACTIVE_LISTING_ACTIVITY_WHERE,
  ACTIVE_OFFER_ACTIVITY_WHERE,
  SALE_ORDER_WHERE,
  isOrderSale,
} from "../utils/orderSale.js";

const activities = new Hono();

/** Feed item built from a Transfer row — "mint" when fromAddress is the zero address. */
interface TransferActivityItem {
  type: "mint" | "transfer";
  chain: Chain;
  contractAddress: string;
  tokenId: string;
  from: string | null;
  to: string;
  blockNumber: string;
  amount: string;
  txHash: string;
  timestamp: Date;
}

/** Feed item built from an Order row. */
interface OrderActivityItem {
  type: "sale" | "offer" | "listing" | "cancelled";
  chain: Chain;
  orderHash: string;
  nftContract: string | null;
  nftTokenId: string | null;
  offerer: string;
  fulfiller: string | null;
  price: { raw: string | null; formatted: string | null; currency: string | null };
  tokenStandard: string;
  txHash: string;
  timestamp: Date;
}

type ActivityFeedItem = TransferActivityItem | OrderActivityItem;

function isTransferActivityItem(item: ActivityFeedItem): item is TransferActivityItem {
  return item.type === "mint" || item.type === "transfer";
}

/** The (contract, tokenId) pair an activity item refers to — field names differ
 *  by which table the item came from (Transfer vs Order). */
function activityItemToken(item: ActivityFeedItem): { contract: string | null; tokenId: string | null } {
  if (isTransferActivityItem(item)) return { contract: item.contractAddress, tokenId: item.tokenId };
  return { contract: item.nftContract, tokenId: item.nftTokenId };
}

/** Classify a Transfer row as "mint" (fromAddress is zero) or "transfer". */
function transferType(fromAddress: string): "mint" | "transfer" {
  return fromAddress === ZERO_ADDRESS ? "mint" : "transfer";
}

/** Fetch token name/image for a list of activity items (single DB query). */
async function batchActivityTokenMeta(
  feed: ActivityFeedItem[]
): Promise<Map<string, { name: string | null; image: string | null }>> {
  const pairs = feed
    .map((item) => ({ chain: item.chain, ...activityItemToken(item) }))
    .filter(
      (p): p is { chain: Chain; contract: string; tokenId: string } =>
        !!p.chain && !!p.contract && !!p.tokenId
    )
    .map((p) => ({ chain: p.chain, contractAddress: p.contract, tokenId: p.tokenId }));

  if (!pairs.length) return new Map();

  const tokens = await prisma.token.findMany({
    where: { OR: pairs },
    select: { contractAddress: true, tokenId: true, name: true, image: true },
  });

  return new Map(
    tokens.map((t) => [`${t.contractAddress}-${t.tokenId}`, { name: t.name, image: t.image }])
  );
}

/**
 * Moderation filter shared by both activity feeds: contracts/tokens flagged
 * isHidden are excluded from results. Two cheap indexed findFirst probes skip
 * the full list fetch when nothing is hidden (the common case).
 */
async function loadHiddenContentFilter(): Promise<{
  hiddenTokenSet: Set<string>;
  hiddenContractFilter: { notIn: string[] } | undefined;
}> {
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

  return {
    hiddenTokenSet,
    hiddenContractFilter: hiddenContracts.length > 0 ? { notIn: hiddenContracts } : undefined,
  };
}

// GET /v1/activities
activities.get("/", publicCache(15), async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const type = c.req.query("type");

  const skip = (page - 1) * limit;

  const { hiddenTokenSet, hiddenContractFilter } = await loadHiddenContentFilter();

  // "mint" and "transfer" both come from the Transfer table; mints have fromAddress = ZERO_ADDRESS
  const wantTransfers = !type || type === "transfer" || type === "mint";
  const wantOrders = !type || ["sale", "listing", "offer", "cancelled"].includes(type);

  const orderStatusFilter =
    type === "sale"
      ? SALE_ORDER_WHERE
      : type === "listing"
      ? ACTIVE_LISTING_ACTIVITY_WHERE
      : type === "cancelled"
      ? { status: "CANCELLED" as const }
      : type === "offer"
      ? ACTIVE_OFFER_ACTIVITY_WHERE
      : {};

  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const transferWhere: Prisma.TransferWhereInput = { ...chainWhere(chainFilter) };
  if (type === "mint") transferWhere.fromAddress = ZERO_ADDRESS;
  if (type === "transfer") transferWhere.fromAddress = { not: ZERO_ADDRESS };
  if (hiddenContractFilter) transferWhere.contractAddress = hiddenContractFilter;

  const orderWhere: Prisma.OrderWhereInput = { ...chainWhere(chainFilter), ...orderStatusFilter };
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

  // Collect txHashes of sale orders so we can suppress the redundant Transfer
  // row that the marketplace contract emits during a sale (same tx, misleading type).
  const saleTxHashes = new Set(
    orders
      .filter((o) => isOrderSale(o) && (o.fulfilledTxHash || o.createdTxHash))
      .map((o) => (o.fulfilledTxHash ?? o.createdTxHash) as string)
  );

  const rawFeed: ActivityFeedItem[] = [
    ...transfers
      .filter((t) => !saleTxHashes.has(t.txHash)) // suppress transfer rows that belong to a sale
      .map((t): TransferActivityItem => ({
        type: transferType(t.fromAddress),
        chain: t.chain,
        contractAddress: t.contractAddress,
        tokenId: t.tokenId,
        from: t.fromAddress === ZERO_ADDRESS ? null : t.fromAddress,
        to: t.toAddress,
        blockNumber: t.blockNumber.toString(),
        amount: t.amount ?? "1",
        txHash: t.txHash,
        timestamp: t.createdAt,
      })),
    ...orders.map((o): OrderActivityItem => ({
      type:
        isOrderSale(o)
          ? "sale"
          : o.status === "ACTIVE" && o.offerItemType === "ERC20"
          ? "offer"
          : o.status === "ACTIVE"
          ? "listing"
          : "cancelled",
      chain: o.chain,
      orderHash: o.orderHash,
      nftContract: o.nftContract,
      nftTokenId: o.nftTokenId,
      offerer: o.offerer,
      fulfiller: o.fulfiller,
      price: { raw: o.priceRaw, formatted: o.priceFormatted, currency: o.currencySymbol },
      tokenStandard: o.offerItemType === "ERC20" ? o.considerationItemType : o.offerItemType,
      txHash: o.createdTxHash,
      timestamp: o.updatedAt,
    })),
  ]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);

  const feed =
    hiddenTokenSet.size > 0
      ? rawFeed.filter((item) => {
          const { contract, tokenId } = activityItemToken(item);
          return !hiddenTokenSet.has(`${contract}:${tokenId}`);
        })
      : rawFeed;

  // Enrich feed items with token name/image
  const tokenMeta = await batchActivityTokenMeta(feed);
  const enrichedFeed = feed.map((item) => {
    const { contract, tokenId } = activityItemToken(item);
    const meta = tokenMeta.get(`${contract}-${tokenId}`);
    return { ...item, token: meta ? { name: meta.name, image: meta.image } : null };
  });

  return c.json({ data: enrichedFeed, meta: { page, limit, total: transferCount + orderCount } });
});

// GET /v1/activities/:address
activities.get("/:address", publicCache(15), async (c) => {
  const { address } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const skip = (page - 1) * limit;
  const addr = normalizeAddress(chain, address);

  const { hiddenTokenSet, hiddenContractFilter } = await loadHiddenContentFilter();

  const transferWhere: Prisma.TransferWhereInput = {
    chain,
    OR: [{ fromAddress: addr }, { toAddress: addr }],
  };
  if (hiddenContractFilter) transferWhere.contractAddress = hiddenContractFilter;

  const orderWhere: Prisma.OrderWhereInput = { chain, OR: [{ offerer: addr }, { fulfiller: addr }] };
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

  // Suppress transfer rows that are part of a sale
  const saleTxHashes = new Set(
    orders
      .filter((o) => isOrderSale(o) && (o.fulfilledTxHash || o.createdTxHash))
      .map((o) => (o.fulfilledTxHash ?? o.createdTxHash) as string)
  );

  const rawFeed: ActivityFeedItem[] = [
    ...transfers
      .filter((t) => !saleTxHashes.has(t.txHash))
      .map((t): TransferActivityItem => ({
        type: transferType(t.fromAddress),
        chain: t.chain,
        contractAddress: t.contractAddress,
        tokenId: t.tokenId,
        from: t.fromAddress === ZERO_ADDRESS ? null : t.fromAddress,
        to: t.toAddress,
        blockNumber: t.blockNumber.toString(),
        amount: t.amount ?? "1",
        txHash: t.txHash,
        timestamp: t.createdAt,
      })),
    ...orders.map((o): OrderActivityItem => ({
      type:
        isOrderSale(o)
          ? "sale"
          : o.status === "ACTIVE" && o.offerItemType === "ERC20"
          ? "offer"
          : o.status === "ACTIVE"
          ? "listing"
          : "cancelled",
      chain: o.chain,
      orderHash: o.orderHash,
      nftContract: o.nftContract,
      nftTokenId: o.nftTokenId,
      offerer: o.offerer,
      fulfiller: o.fulfiller,
      price: { raw: o.priceRaw, formatted: o.priceFormatted, currency: o.currencySymbol },
      tokenStandard: o.offerItemType === "ERC20" ? o.considerationItemType : o.offerItemType,
      txHash: o.createdTxHash,
      timestamp: o.updatedAt,
    })),
  ]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);

  const feed =
    hiddenTokenSet.size > 0
      ? rawFeed.filter((item) => {
          const { contract, tokenId } = activityItemToken(item);
          return !hiddenTokenSet.has(`${contract}:${tokenId}`);
        })
      : rawFeed;

  // Enrich feed items with token name/image
  const tokenMeta = await batchActivityTokenMeta(feed);
  const enrichedFeed = feed.map((item) => {
    const { contract, tokenId } = activityItemToken(item);
    const meta = tokenMeta.get(`${contract}-${tokenId}`);
    return { ...item, token: meta ? { name: meta.name, image: meta.image } : null };
  });

  return c.json({ data: enrichedFeed, meta: { page, limit } });
});

export default activities;
