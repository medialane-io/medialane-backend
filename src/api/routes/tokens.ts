import { Hono } from "hono";
import type { Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import { worker } from "../../orchestrator/worker.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { serializeOrder, serializeToken, batchOrdersByToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { isOrderSale } from "../utils/orderSale.js";
import { parseChainFilter, chainWhere, parseSingleChain } from "../utils/chainFilter.js";

const log = createLogger("routes:tokens");
const tokens = new Hono();

const SLUG_TO_IP_TYPE: Record<string, string> = {
  audio: "Audio",
  art: "Art",
  documents: "Documents",
  video: "Video",
  photography: "Photography",
  patents: "Patents",
  posts: "Posts",
  publications: "Publications",
  rwa: "RWA",
  software: "Software",
  custom: "Custom",

};

tokens.get("/", async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(48, Math.max(1, Number(c.req.query("limit") ?? 24)));
  const sort  = c.req.query("sort") === "oldest" ? "oldest" : "recent";
  const ipTypeSlug = (c.req.query("ipType") ?? "").toLowerCase().trim();
  const derivatives = (c.req.query("derivatives") ?? "").toLowerCase().trim();
  const skip  = (page - 1) * limit;
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);

  const where: Prisma.TokenWhereInput = { ...chainWhere(chainFilter), isHidden: false };

  if (ipTypeSlug) {
    if (ipTypeSlug === "nft") {

      where.OR = [{ ipType: "NFT" }, { ipType: null }];
    } else {
      const canonical = SLUG_TO_IP_TYPE[ipTypeSlug];
      if (canonical) where.ipType = canonical;

    }
  }

  if (derivatives === "allowed") {
    where.AND = [
      {
        OR: [
          { attributes: { array_contains: [{ trait_type: "Derivatives", value: "Allowed" }] } },
          { attributes: { array_contains: [{ trait_type: "Derivatives", value: "Share-Alike" }] } },
        ],
      },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where,
      orderBy: sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" },
      skip,
      take: limit,
      include: { collection: { select: { standard: true } } },
    }),
    prisma.token.count({ where }),
  ]);

  const ordersByToken = await batchOrdersByToken(
    data.map((t) => ({ chain: t.chain, contractAddress: t.contractAddress, tokenId: t.tokenId })),
  );

  return c.json({
    data: data.map((t) =>
      serializeToken(t, ordersByToken.get(`${t.contractAddress}:${t.tokenId}`) ?? [])
    ),
    meta: { page, limit, total },
  });
});

tokens.get("/batch", async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const itemsParam = c.req.query("items") ?? "";
  const pairs = itemsParam
    .split(",")
    .slice(0, 50)
    .map((s) => s.trim())
    .filter(Boolean);

  if (pairs.length === 0) {
    return c.json({ error: "items query param required. Format: contract1:tokenId1,contract2:tokenId2" }, 400);
  }

  const parsed = pairs
    .map((p) => {
      const colonIdx = p.indexOf(":");
      if (colonIdx === -1) return null;
      const contract = p.slice(0, colonIdx);
      const tokenId = p.slice(colonIdx + 1);
      return contract && tokenId
        ? { contractAddress: normalizeAddress(chain, contract), tokenId }
        : null;
    })
    .filter((x): x is { contractAddress: string; tokenId: string } => x !== null);

  if (parsed.length === 0) {
    return c.json({ error: "No valid contract:tokenId pairs found" }, 400);
  }

  const results = await prisma.token.findMany({
    where: {
      chain,
      OR: parsed.map((p) => ({
        contractAddress: p.contractAddress,
        tokenId: p.tokenId,
      })),
    },
    include: { collection: { select: { standard: true } } },
  });

  return c.json({ data: results.map((t) => serializeToken(t, [])) });
});

tokens.get("/owned/:address", async (c) => {
  const { address } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const owner = normalizeAddress(chain, address);

  const [balanceRows, total] = await Promise.all([
    prisma.tokenBalance.findMany({
      where: { chain, owner, amount: { not: "0" } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: { contractAddress: true, tokenId: true, amount: true },
    }),
    prisma.tokenBalance.count({ where: { chain, owner, amount: { not: "0" } } }),
  ]);

  const pairs = balanceRows.map((b) => ({ contractAddress: b.contractAddress, tokenId: b.tokenId }));
  const data = pairs.length > 0
    ? await prisma.token.findMany({
        where: { chain, isHidden: false, OR: pairs },
        include: { collection: { select: { standard: true } } },
      })
    : [];

  const ordersByToken = await batchOrdersByToken(
    data.map((t) => ({ chain, contractAddress: t.contractAddress, tokenId: t.tokenId })),
  );

  return c.json({
    data: data.map((t) =>
      serializeToken(t, ordersByToken.get(`${t.contractAddress}:${t.tokenId}`) ?? [])
    ),
    meta: { page, limit, total },
  });
});

tokens.get("/:contract/:tokenId/comments", async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const contract = normalizeAddress(chain, c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const skip = (page - 1) * limit;

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where: { chain, contractAddress: contract, tokenId, isHidden: false },
      orderBy: { blockTimestamp: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        chain: true,
        contractAddress: true,
        tokenId: true,
        author: true,
        content: true,
        txHash: true,
        blockNumber: true,
        blockTimestamp: true,
      },
    }),
    prisma.comment.count({
      where: { chain, contractAddress: contract, tokenId, isHidden: false },
    }),
  ]);

  const data = comments.map((row) => ({
    ...row,
    blockNumber: row.blockNumber.toString(),
    blockTimestamp: row.blockTimestamp.toString(),
    postedAt: new Date(Number(row.blockTimestamp) * 1000).toISOString(),
  }));

  return c.json({ data, meta: { page, limit, total } });
});

tokens.get("/:contract/:tokenId/remixes", async (c) => {

  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));

  const [remixes, total] = await Promise.all([
    prisma.remixOffer.findMany({
      where: {
        originalContract: contract,
        originalTokenId: tokenId,
        status: { in: ["APPROVED", "COMPLETED", "SELF_MINTED"] },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        remixContract: true,
        remixTokenId: true,
        licenseType: true,
        commercial: true,
        derivatives: true,
        createdAt: true,
      },
    }),
    prisma.remixOffer.count({
      where: {
        originalContract: contract,
        originalTokenId: tokenId,
        status: { in: ["APPROVED", "COMPLETED", "SELF_MINTED"] },
      },
    }),
  ]);

  return c.json({ data: remixes, meta: { page, limit, total } });
});

tokens.get("/:contract/:tokenId", async (c) => {
  const { contract, tokenId } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const waitParam = c.req.query("wait");
  const wait = waitParam === "true" || waitParam === "1";
  const contractAddress = normalizeAddress(chain, contract);

  let token = await prisma.token.findUnique({
    where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
    include: { collection: { select: { standard: true } } },
  });

  if (!token) {
    return c.json({ error: "Token not found" }, 404);
  }

  if (token.metadataStatus === "PENDING" || token.metadataStatus === "FAILED") {
    if (wait && token.tokenUri) {

      const metadata = await Promise.race([
        resolveMetadata(token.tokenUri).then((m) => m),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      if (metadata) {
        await prisma.token.update({
          where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
          data: {
            metadataStatus: "FETCHED",
            name: (metadata.name as string) ?? null,
            description: (metadata.description as string) ?? null,
            image: (metadata.image as string) ?? null,
            animationUrl: (metadata.animation_url as string) ?? null,
            attributes: (metadata.attributes as any) ?? undefined,
          },
        });
        token = await prisma.token.findUnique({
          where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
          include: { collection: { select: { standard: true } } },
        }) ?? token;
      }
    } else {

      worker.enqueue({ type: "METADATA_FETCH", chain, contractAddress, tokenId });
    }
  }

  const [activeOrders, balances] = await Promise.all([
    prisma.order.findMany({
      where: { chain, nftContract: contractAddress, nftTokenId: tokenId, status: "ACTIVE" },
      take: 5,
    }),
    prisma.tokenBalance.findMany({
      where: { chain, contractAddress, tokenId, amount: { not: "0" } },
      select: { owner: true, amount: true },
      orderBy: { amount: "desc" },
      take: 50,
    }),
  ]);

  return c.json({ data: serializeToken(token, activeOrders, balances) });
});

tokens.get("/:contract/:tokenId/history", async (c) => {
  const { contract, tokenId } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const contractLower = normalizeAddress(chain, contract);

  const [transfers, orders, fills] = await Promise.all([
    prisma.transfer.findMany({
      where: { chain, contractAddress: contractLower, tokenId },
      orderBy: { blockNumber: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.findMany({
      where: { chain, nftContract: contractLower, nftTokenId: tokenId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.orderFill.findMany({
      where: { chain, nftContract: contractLower, nftTokenId: tokenId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const saleTxHashes = new Set(fills.map((fill) => fill.txHash));

  const activities = [
    ...transfers
      .filter((t) => !saleTxHashes.has(t.txHash))
      .map((t) => ({
        type: t.fromAddress === ZERO_ADDRESS ? "mint" : "transfer",
        from: t.fromAddress === ZERO_ADDRESS ? null : t.fromAddress,
        to: t.toAddress,
        amount: t.amount,
        blockNumber: t.blockNumber.toString(),
        txHash: t.txHash,
        timestamp: t.createdAt,
      })),
    ...fills.map((fill) => ({
      type: "sale",
      orderHash: fill.orderHash,
      price: { raw: fill.priceRaw, formatted: fill.priceFormatted, currency: fill.currencySymbol },
      fulfiller: fill.fulfiller,
      amount: fill.quantity,
      txHash: fill.txHash,
      timestamp: fill.createdAt,
    })),
    ...orders.filter((o) => !isOrderSale(o)).map((o) => ({
      type:
        o.status === "ACTIVE" && o.offerItemType === "ERC20"
          ? "offer"
          : o.status === "ACTIVE"
          ? "listing"
          : "cancelled",
      orderHash: o.orderHash,
      price: { raw: o.priceRaw, formatted: o.priceFormatted, currency: o.currencySymbol },
      offerer: o.offerer,
      fulfiller: o.fulfiller,
      txHash: o.createdTxHash,
      timestamp: o.createdAt,
    })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return c.json({ data: activities, meta: { page, limit } });
});

export default tokens;
