import { Hono } from "hono";
import prisma from "../../db/client.js";
import { enqueueJob } from "../../orchestrator/queue.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:tokens");
const tokens = new Hono();

// GET /v1/tokens/owned/:address  — must be registered BEFORE /:contract/:tokenId
tokens.get("/owned/:address", async (c) => {
  const { address } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain: "STARKNET", owner: address.toLowerCase() },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.token.count({ where: { chain: "STARKNET", owner: address.toLowerCase() } }),
  ]);

  return c.json({ data: data.map((t) => serializeToken(t, [])), meta: { page, limit, total } });
});

// GET /v1/tokens/:contract/:tokenId
tokens.get("/:contract/:tokenId", async (c) => {
  const { contract, tokenId } = c.req.param();
  const waitParam = c.req.query("wait");
  const wait = waitParam === "true" || waitParam === "1";
  const contractLower = contract.toLowerCase();

  let token = await prisma.token.findUnique({
    where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress: contractLower, tokenId } },
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
          where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress: contractLower, tokenId } },
          data: {
            metadataStatus: "FETCHED",
            name: (metadata.name as string) ?? null,
            description: (metadata.description as string) ?? null,
            image: (metadata.image as string) ?? null,
            attributes: (metadata.attributes as any) ?? undefined,
          },
        });
        token = await prisma.token.findUnique({
          where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress: contractLower, tokenId } },
        }) ?? token;
      }
    } else {
      // Enqueue async
      await enqueueJob("METADATA_FETCH", {
        chain: "STARKNET",
        contractAddress: contractLower,
        tokenId,
      });
    }
  }

  // Load active orders separately (relation removed for multichain schema)
  const activeOrders = await prisma.order.findMany({
    where: { chain: "STARKNET", nftContract: contractLower, nftTokenId: tokenId, status: "ACTIVE" },
    take: 5,
  });

  return c.json({ data: serializeToken(token, activeOrders) });
});

// GET /v1/tokens/:contract/:tokenId/history
tokens.get("/:contract/:tokenId/history", async (c) => {
  const { contract, tokenId } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const contractLower = contract.toLowerCase();

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

  const activities = [
    ...transfers.map((t) => ({
      type: "transfer",
      from: t.fromAddress,
      to: t.toAddress,
      blockNumber: t.blockNumber.toString(),
      txHash: t.txHash,
      timestamp: t.createdAt,
    })),
    ...orders.map((o) => ({
      type: o.status === "FULFILLED" ? "sale" : o.status === "ACTIVE" ? "listing" : "cancelled",
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


function serializeToken(token: any, activeOrders: any[]) {
  return {
    id: token.id,
    chain: token.chain,
    contractAddress: token.contractAddress,
    tokenId: token.tokenId,
    owner: token.owner,
    tokenUri: token.tokenUri,
    metadataStatus: token.metadataStatus,
    metadata: {
      name: token.name,
      description: token.description,
      image: token.image,
      attributes: token.attributes,
      ipType: token.ipType,
      licenseType: token.licenseType,
      commercialUse: token.commercialUse,
      author: token.author,
    },
    activeOrders,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

export default tokens;
