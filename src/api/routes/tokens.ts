import { Hono } from "hono";
import { validated } from "../http/validate.js";
import type { Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import { worker } from "../../orchestrator/worker.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { serializeOrder, serializeToken, batchOrdersByToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { isOrderSale } from "../utils/orderSale.js";
import { chainWhere } from "../utils/chainFilter.js";
import { readTokenFromChain } from "./tokens.readThrough.js";
import { tokenHolders, tokenBalanceOf } from "../utils/tokenHolders.js";
import { storedImage, storedTokenUri } from "../../utils/onchainContent.js";
import { liveDescription } from "../utils/liveDescription.js";
import { chainFilterScope, chainScope } from "../http/chain.js";
import { pageQuery } from "../http/page.js";

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

tokens.get("/", chainFilterScope(), validated("query", pageQuery({ defaultLimit: 24, maxLimit: 48 })), async (c) => {
  const { page, limit, skip } = c.req.valid("query");
  const sort  = c.req.query("sort") === "oldest" ? "oldest" : "recent";
  const ipTypeSlug = (c.req.query("ipType") ?? "").toLowerCase().trim();
  const derivatives = (c.req.query("derivatives") ?? "").toLowerCase().trim();
  const chainFilter = c.get("chainFilter");

  const where: Prisma.TokenWhereInput = { ...chainWhere(chainFilter), isHidden: false, metadataStatus: "FETCHED" };

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

tokens.get("/batch", chainScope(), async (c) => {
  const chain = c.get("chain");
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

tokens.get("/owned/:address", chainScope(), validated("query", pageQuery()), async (c) => {
  const { address } = c.req.param();
  const chain = c.get("chain");
  const { page, limit } = c.req.valid("query");
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

tokens.get("/:contract/:tokenId/comments", chainScope(), validated("query", pageQuery({ maxLimit: 50 })), async (c) => {
  const chain = c.get("chain");
  const contract = normalizeAddress(chain, c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const { page, limit, skip } = c.req.valid("query");

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

tokens.get("/:contract/:tokenId", chainScope(), async (c) => {
  const { contract, tokenId } = c.req.param();
  const chain = c.get("chain");
  const waitParam = c.req.query("wait");
  const wait = waitParam === "true" || waitParam === "1";
  const contractAddress = normalizeAddress(chain, contract);

  let token = await prisma.token.findUnique({
    where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
    include: { collection: { select: { standard: true } } },
  });

  let liveTokenUri: string | null = null;
  if (!token) {
    const collection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain, contractAddress } },
      select: { standard: true },
    });

    const onChain = await readTokenFromChain(chain, contractAddress, tokenId, collection?.standard ?? null);
    if (!onChain) {
      return c.json({ error: "Token not found" }, 404);
    }
    liveTokenUri = onChain.tokenUri;

    await prisma.token.upsert({
      where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
      create: { chain, contractAddress, tokenId, tokenUri: storedTokenUri(onChain.tokenUri), metadataStatus: "PENDING" },
      update: {},
    });
    log.info({ contractAddress, tokenId }, "read-through: adopted a token the indexer had not reached yet");

    token = await prisma.token.findUnique({
      where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
      include: { collection: { select: { standard: true } } },
    });
    if (!token) return c.json({ error: "Token not found" }, 404);
  }

  if (token.metadataStatus === "PENDING" || token.metadataStatus === "FAILED") {
    const metadataUri = token.tokenUri ?? liveTokenUri;
    if (wait && metadataUri) {

      const metadata = await Promise.race([
        resolveMetadata(metadataUri).then((m) => m),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      if (metadata) {
        await prisma.token.update({
          where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
          data: {
            metadataStatus: "FETCHED",
            name: (metadata.name as string) ?? null,
            image: storedImage(metadata.image, chain, contractAddress, tokenId),
            animationUrl: (metadata.animation_url as string) ?? null,
            attributes: (metadata.attributes as Prisma.InputJsonValue | undefined) ?? undefined,
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

  const [activeOrders, { holders, holderCount, supply }, description] = await Promise.all([
    prisma.order.findMany({
      where: { chain, nftContract: contractAddress, nftTokenId: tokenId, status: "ACTIVE" },
      take: 5,
    }),
    tokenHolders(chain, contractAddress, tokenId),
    liveDescription(chain, contractAddress, tokenId, token.tokenUri ?? liveTokenUri),
  ]);

  return c.json({ data: { ...serializeToken(token, activeOrders, holders, description), holderCount, supply } });
});

tokens.get("/:contract/:tokenId/balances/:owner", chainScope(), async (c) => {
  const { contract, tokenId, owner } = c.req.param();
  const chain = c.get("chain");
  const holder = normalizeAddress(chain, owner);
  const amount = await tokenBalanceOf(chain, normalizeAddress(chain, contract), tokenId, holder);
  return c.json({ data: { owner: holder, amount } });
});

tokens.get("/:contract/:tokenId/history", chainScope(), validated("query", pageQuery()), async (c) => {
  const { contract, tokenId } = c.req.param();
  const chain = c.get("chain");
  const { page, limit } = c.req.valid("query");
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
