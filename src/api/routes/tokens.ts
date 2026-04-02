import { Hono } from "hono";
import { num as starkNum, RpcProvider } from "starknet";
import prisma from "../../db/client.js";
import { worker } from "../../orchestrator/worker.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { serializeOrder, serializeToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { env } from "../../config/env.js";
import { TRANSFER_SELECTOR, ZERO_ADDRESS } from "../../config/constants.js";
import { u256ToBigInt } from "../../utils/bigint.js";

const log = createLogger("routes:tokens");
const tokens = new Hono();

function parseMintTransfer(event: any): { contractAddress: string; tokenId: string; to: string } | null {
  if (!event?.from_address || !Array.isArray(event?.keys) || !event.keys[0]) return null;
  if (starkNum.toHex(event.keys[0]) !== starkNum.toHex(TRANSFER_SELECTOR)) return null;

  const data = Array.isArray(event.data) ? event.data : [];
  // Most Starknet ERC-721 Transfer events use keys:
  // [selector, from, to, tokenId.low, tokenId.high]
  if (event.keys.length >= 5) {
    const from = normalizeAddress(event.keys[1]);
    if (from !== ZERO_ADDRESS) return null;
    const to = normalizeAddress(event.keys[2]);
    const tokenId = u256ToBigInt(event.keys[3], event.keys[4]).toString();
    return { contractAddress: normalizeAddress(event.from_address), tokenId, to };
  }

  // Fallback shape: data [from, to, tokenId.low, tokenId.high, ...]
  if (data.length >= 4) {
    const from = normalizeAddress(data[0]);
    if (from !== ZERO_ADDRESS) return null;
    const to = normalizeAddress(data[1]);
    const tokenId = u256ToBigInt(data[2], data[3]).toString();
    return { contractAddress: normalizeAddress(event.from_address), tokenId, to };
  }
  return null;
}

// POST /v1/tokens/sync-tx — index minted token Transfer events immediately from tx receipt
tokens.post("/sync-tx", async (c) => {
  const body = await c.req.json().catch(() => null);
  const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
  if (!txHash) return c.json({ error: "txHash required" }, 400);

  try {
    const provider = new RpcProvider({ nodeUrl: env.ALCHEMY_RPC_URL });
    const receipt = await provider.getTransactionReceipt(txHash);
    const events: any[] = (receipt as any).events ?? [];
    const blockNumber = BigInt((receipt as any).block_number ?? 0);

    const mints = events
      .map((e) => parseMintTransfer(e))
      .filter(
        (x): x is { contractAddress: string; tokenId: string; to: string } =>
          x !== null
      );

    if (mints.length === 0) {
      return c.json({ data: { synced: 0, message: "No mint Transfer events found in this transaction" } });
    }

    let synced = 0;
    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i];

      await prisma.$transaction(async (tx) => {
        await tx.token.upsert({
          where: {
            chain_contractAddress_tokenId: {
              chain: "STARKNET",
              contractAddress: mint.contractAddress,
              tokenId: mint.tokenId,
            },
          },
          create: {
            chain: "STARKNET",
            contractAddress: mint.contractAddress,
            tokenId: mint.tokenId,
            owner: mint.to,
            metadataStatus: "PENDING",
          },
          update: { owner: mint.to },
        });

        await tx.collection.upsert({
          where: { chain_contractAddress: { chain: "STARKNET", contractAddress: mint.contractAddress } },
          create: {
            chain: "STARKNET",
            contractAddress: mint.contractAddress,
            startBlock: blockNumber,
            isKnown: false,
            metadataStatus: "PENDING",
          },
          update: {},
        });

        try {
          await tx.transfer.create({
            data: {
              chain: "STARKNET",
              contractAddress: mint.contractAddress,
              tokenId: mint.tokenId,
              fromAddress: ZERO_ADDRESS,
              toAddress: mint.to,
              blockNumber,
              txHash,
              logIndex: i,
            },
          });
        } catch (err: unknown) {
          if ((err as { code?: string }).code !== "P2002") throw err;
        }
      });

      worker.enqueue({
        type: "METADATA_FETCH",
        chain: "STARKNET",
        contractAddress: mint.contractAddress,
        tokenId: mint.tokenId,
      });
      worker.enqueue({ type: "STATS_UPDATE", chain: "STARKNET", contractAddress: mint.contractAddress });
      synced++;
    }

    return c.json({ data: { synced } });
  } catch (err) {
    log.error({ err, txHash }, "tokens/sync-tx failed");
    return c.json({ error: String(err) }, 500);
  }
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

// GET /v1/tokens/:contract/:tokenId/remixes — public list of minted remixes
// Must be registered BEFORE /:contract/:tokenId to avoid route conflict
tokens.get("/:contract/:tokenId/remixes", async (c) => {
  const contract = normalizeAddress(c.req.param("contract"));
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
