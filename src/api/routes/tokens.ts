import { Hono } from "hono";
import prisma from "../../db/client.js";
import { worker } from "../../orchestrator/worker.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { serializeOrder, serializeToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";

const log = createLogger("routes:tokens");
const tokens = new Hono();

// Slug → canonical DB value for ipType column
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
  // "nft" is handled separately (NFT | null)
};

// GET /v1/tokens — browse all indexed tokens, optionally filtered by IP type
// Query params: ?ipType=audio|art|video|nft|... &page= &limit= &sort=recent|oldest
tokens.get("/", async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(48, Math.max(1, Number(c.req.query("limit") ?? 24)));
  const sort  = c.req.query("sort") === "oldest" ? "oldest" : "recent";
  const ipTypeSlug = (c.req.query("ipType") ?? "").toLowerCase().trim();
  const skip  = (page - 1) * limit;

  const where: any = { chain: "STARKNET", isHidden: false };

  if (ipTypeSlug) {
    if (ipTypeSlug === "nft") {
      // "nft" catches explicitly tagged NFT + untagged/external tokens (null)
      where.OR = [{ ipType: "NFT" }, { ipType: null }];
    } else {
      const canonical = SLUG_TO_IP_TYPE[ipTypeSlug];
      if (canonical) where.ipType = canonical;
      // Unknown slug → no ipType filter (returns all tokens)
    }
  }

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where,
      orderBy: sort === "oldest" ? { createdAt: "asc" } : { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.token.count({ where }),
  ]);

  // Batch-load active orders for returned tokens in a single query
  const activeOrdersAll =
    data.length > 0
      ? await prisma.order.findMany({
          where: {
            chain: "STARKNET",
            status: "ACTIVE",
            OR: data.map((t) => ({ nftContract: t.contractAddress, nftTokenId: t.tokenId })),
          },
        })
      : [];

  const ordersByToken = new Map<string, typeof activeOrdersAll>();
  for (const order of activeOrdersAll) {
    const key = `${order.nftContract}:${order.nftTokenId}`;
    const existing = ordersByToken.get(key) ?? [];
    existing.push(order);
    ordersByToken.set(key, existing);
  }

  return c.json({
    data: data.map((t) =>
      serializeToken(t, ordersByToken.get(`${t.contractAddress}:${t.tokenId}`) ?? [])
    ),
    meta: { page, limit, total },
  });
});

// GET /v1/tokens/batch — fetch multiple tokens by contract:tokenId pairs
// Must be registered BEFORE /:contract/:tokenId to avoid route conflict
tokens.get("/batch", async (c) => {
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
        ? { contractAddress: normalizeAddress(contract), tokenId }
        : null;
    })
    .filter((x): x is { contractAddress: string; tokenId: string } => x !== null);

  if (parsed.length === 0) {
    return c.json({ error: "No valid contract:tokenId pairs found" }, 400);
  }

  const results = await prisma.token.findMany({
    where: {
      chain: "STARKNET",
      OR: parsed.map((p) => ({
        contractAddress: p.contractAddress,
        tokenId: p.tokenId,
      })),
    },
  });

  return c.json({ data: results.map((t) => serializeToken(t, [])) });
});

// GET /v1/tokens/owned/:address  — must be registered BEFORE /:contract/:tokenId
tokens.get("/owned/:address", async (c) => {
  const { address } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain: "STARKNET", owner: normalizeAddress(address), isHidden: false },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.token.count({ where: { chain: "STARKNET", owner: normalizeAddress(address), isHidden: false } }),
  ]);

  // Batch-load active orders for all returned tokens in a single query
  const activeOrdersAll = data.length > 0
    ? await prisma.order.findMany({
        where: {
          chain: "STARKNET",
          status: "ACTIVE",
          OR: data.map((t) => ({ nftContract: t.contractAddress, nftTokenId: t.tokenId })),
        },
      })
    : [];

  // Group orders by (contractAddress, tokenId)
  const ordersByToken = new Map<string, typeof activeOrdersAll>();
  for (const order of activeOrdersAll) {
    const key = `${order.nftContract}:${order.nftTokenId}`;
    const existing = ordersByToken.get(key) ?? [];
    existing.push(order);
    ordersByToken.set(key, existing);
  }

  return c.json({
    data: data.map((t) =>
      serializeToken(t, ordersByToken.get(`${t.contractAddress}:${t.tokenId}`) ?? [])
    ),
    meta: { page, limit, total },
  });
});

// GET /v1/tokens/:contract/:tokenId/comments
// Must be registered BEFORE /:contract/:tokenId to avoid route conflict
tokens.get("/:contract/:tokenId/comments", async (c) => {
  const contract = normalizeAddress(c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const skip = (page - 1) * limit;

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where: { chain: "starknet", contractAddress: contract, tokenId, isHidden: false },
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
      where: { chain: "starknet", contractAddress: contract, tokenId, isHidden: false },
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

// GET /v1/tokens/:contract/:tokenId
tokens.get("/:contract/:tokenId", async (c) => {
  const { contract, tokenId } = c.req.param();
  const waitParam = c.req.query("wait");
  const wait = waitParam === "true" || waitParam === "1";
  const contractAddress = normalizeAddress(contract);

  let token = await prisma.token.findUnique({
    where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress, tokenId } },
  });

  if (!token) {
    return c.json({ error: "Token not found" }, 404);
  }

  // JIT metadata fetch
  if (token.metadataStatus === "PENDING" || token.metadataStatus === "FAILED") {
    if (wait && token.tokenUri) {
      // Block up to 3s for resolution
      const metadata = await Promise.race([
        resolveMetadata(token.tokenUri).then((m) => m),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (metadata) {
        await prisma.token.update({
          where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress, tokenId } },
          data: {
            metadataStatus: "FETCHED",
            name: (metadata.name as string) ?? null,
            description: (metadata.description as string) ?? null,
            image: (metadata.image as string) ?? null,
            attributes: (metadata.attributes as any) ?? undefined,
          },
        });
        token = await prisma.token.findUnique({
          where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress, tokenId } },
        }) ?? token;
      }
    } else {
      // Enqueue async — best-effort, worker deduplicates internally
      worker.enqueue({ type: "METADATA_FETCH", chain: "STARKNET", contractAddress, tokenId });
    }
  }

  // Load active orders separately (relation removed for multichain schema)
  const activeOrders = await prisma.order.findMany({
    where: { chain: "STARKNET", nftContract: contractAddress, nftTokenId: tokenId, status: "ACTIVE" },
    take: 5,
  });

  return c.json({ data: serializeToken(token, activeOrders) });
});

// GET /v1/tokens/:contract/:tokenId/history
tokens.get("/:contract/:tokenId/history", async (c) => {
  const { contract, tokenId } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const contractLower = normalizeAddress(contract);

  const [transfers, orders] = await Promise.all([
    prisma.transfer.findMany({
      where: { chain: "STARKNET", contractAddress: contractLower, tokenId },
      orderBy: { blockNumber: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.findMany({
      where: { chain: "STARKNET", nftContract: contractLower, nftTokenId: tokenId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  // Suppress transfer rows that are part of a fulfilled sale (same txHash)
  const saleTxHashes = new Set(
    orders
      .filter((o) => o.status === "FULFILLED" && o.createdTxHash)
      .map((o) => o.createdTxHash as string)
  );

  const activities = [
    ...transfers
      .filter((t) => !saleTxHashes.has(t.txHash))
      .map((t) => ({
        type: t.fromAddress === ZERO_ADDRESS ? "mint" : "transfer",
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
