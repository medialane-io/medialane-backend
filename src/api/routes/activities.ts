import { Hono } from "hono";
import { Prisma, type Chain, type PrismaClient } from "@prisma/client";
import { parseSingleChain, chainWhere, parseChainFilter } from "../utils/chainFilter.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import {
  ACTIVE_LISTING_ACTIVITY_WHERE,
  ACTIVE_OFFER_ACTIVITY_WHERE,
  SALE_ORDER_WHERE,
} from "../utils/orderSale.js";
import { batchTokenMeta } from "../utils/serialize.js";
import { mergeFeed, activityItemToken, MAX_FEED_DEPTH, type ActivityFeedItem } from "./activities.feed.js";

const activities = new Hono();

async function withTokenMeta(feed: ActivityFeedItem[]) {
  const meta = await batchTokenMeta(
    feed.map((item) => {
      const { contract, tokenId } = activityItemToken(item);
      return { chain: item.chain, nftContract: contract, nftTokenId: tokenId };
    }),
  );
  return feed.map((item) => {
    const { contract, tokenId } = activityItemToken(item);
    const m = meta.get(`${contract}-${tokenId}`);
    return { ...item, token: m ? { name: m.name, image: m.image, animationUrl: m.animationUrl } : null };
  });
}

type Db = PrismaClient | Prisma.TransactionClient;

export interface HiddenContentDeps {
  db: Db;
  now: () => number;
  ttlMs: number;
}

type HiddenContentFilter = {
  hiddenTokenSet: Set<string>;
  hiddenContractFilter: { notIn: string[] } | undefined;
};

export const HIDDEN_CONTENT_TTL_MS = 30_000;

let hiddenContentCache: { value: HiddenContentFilter; fetchedAt: number } | null = null;

export function clearHiddenContentCache(): void {
  hiddenContentCache = null;
}

export async function loadHiddenContentFilter(
  deps: HiddenContentDeps = { db: prisma, now: Date.now, ttlMs: HIDDEN_CONTENT_TTL_MS },
): Promise<HiddenContentFilter> {
  const now = deps.now();
  if (hiddenContentCache && now - hiddenContentCache.fetchedAt < deps.ttlMs) {
    return hiddenContentCache.value;
  }

  const { db } = deps;
  const [anyHiddenCollection, anyHiddenToken] = await Promise.all([
    db.collection.findFirst({ where: { isHidden: true }, select: { contractAddress: true } }),
    db.token.findFirst({ where: { isHidden: true }, select: { contractAddress: true } }),
  ]);

  const hiddenContracts: string[] = [];
  const hiddenTokenSet = new Set<string>();

  if (anyHiddenCollection || anyHiddenToken) {
    const [hiddenCols, hiddenToks] = await Promise.all([
      anyHiddenCollection
        ? db.collection.findMany({ where: { isHidden: true }, select: { contractAddress: true } })
        : [],
      anyHiddenToken
        ? db.token.findMany({
            where: { isHidden: true },
            select: { contractAddress: true, tokenId: true },
          })
        : [],
    ]);
    hiddenContracts.push(...hiddenCols.map((c) => c.contractAddress));
    hiddenToks.forEach((t) => hiddenTokenSet.add(`${t.contractAddress}:${t.tokenId}`));
  }

  const value: HiddenContentFilter = {
    hiddenTokenSet,
    hiddenContractFilter: hiddenContracts.length > 0 ? { notIn: hiddenContracts } : undefined,
  };
  hiddenContentCache = { value, fetchedAt: now };
  return value;
}

export function buildActivityWhere(params: {
  chainFilter: { chain: Chain } | "all";
  type?: string;
  contract?: string | null;
  hiddenContractFilter?: { notIn: string[] };
}): { transferWhere: Prisma.TransferWhereInput; orderWhere: Prisma.OrderWhereInput } {
  const { chainFilter, type, contract, hiddenContractFilter } = params;

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

  const transferWhere: Prisma.TransferWhereInput = { ...chainWhere(chainFilter) };
  if (type === "mint") transferWhere.fromAddress = ZERO_ADDRESS;
  if (type === "transfer") transferWhere.fromAddress = { not: ZERO_ADDRESS };

  const orderWhere: Prisma.OrderWhereInput = { ...chainWhere(chainFilter), ...orderStatusFilter };

  if (contract) {
    transferWhere.contractAddress = contract;
    orderWhere.nftContract = contract;
  } else if (hiddenContractFilter) {
    transferWhere.contractAddress = hiddenContractFilter;
    orderWhere.nftContract = hiddenContractFilter;
  }

  return { transferWhere, orderWhere };
}

activities.get("/", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const type = c.req.query("type");

  const skip = (page - 1) * limit;
  const take = skip + limit;
  const deep = take > MAX_FEED_DEPTH;

  const { hiddenTokenSet, hiddenContractFilter } = await loadHiddenContentFilter();

  const wantTransfers = !type || type === "transfer" || type === "mint";
  const wantOrders = !type || ["sale", "listing", "offer", "cancelled"].includes(type);

  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const rawContract = c.req.query("contract");
  const contract = rawContract
    ? normalizeAddress(chainFilter === "all" ? "STARKNET" : chainFilter.chain, rawContract)
    : null;
  const { transferWhere, orderWhere } = buildActivityWhere({ chainFilter, type, contract, hiddenContractFilter });

  const [transfers, orders, transferCount, orderCount] = await Promise.all([
    wantTransfers && !deep
      ? prisma.transfer.findMany({ where: transferWhere, orderBy: { createdAt: "desc" }, take })
      : [],
    wantOrders && !deep
      ? prisma.order.findMany({ where: orderWhere, orderBy: { updatedAt: "desc" }, take })
      : [],
    wantTransfers ? prisma.transfer.count({ where: transferWhere }) : 0,
    wantOrders ? prisma.order.count({ where: orderWhere }) : 0,
  ]);

  const data = await withTokenMeta(mergeFeed(transfers, orders, { skip, limit, hiddenTokenSet }));
  return c.json({ data, meta: { page, limit, total: Math.min(transferCount + orderCount, MAX_FEED_DEPTH) } });
});

activities.get("/:address", async (c) => {
  const { address } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const skip = (page - 1) * limit;
  const take = skip + limit;
  const deep = take > MAX_FEED_DEPTH;
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
    deep ? [] : prisma.transfer.findMany({ where: transferWhere, orderBy: { createdAt: "desc" }, take }),
    deep ? [] : prisma.order.findMany({ where: orderWhere, orderBy: { updatedAt: "desc" }, take }),
  ]);

  const data = await withTokenMeta(mergeFeed(transfers, orders, { skip, limit, hiddenTokenSet }));
  return c.json({ data, meta: { page, limit } });
});

export default activities;
