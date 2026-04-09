import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:drop");

const drop = new Hono<AppEnv>();

// GET /v1/drop/mint-status/:collection/:wallet
// Returns how many tokens the wallet has minted from a drop collection,
// plus the total minted across all wallets.
drop.get("/mint-status/:collection/:wallet", async (c) => {
  const collection = normalizeAddress(c.req.param("collection"));
  const wallet = normalizeAddress(c.req.param("wallet"));

  const [mintedByWallet, totalMinted] = await Promise.all([
    prisma.tokenBalance.count({
      where: { chain: "STARKNET", contractAddress: collection, owner: wallet, amount: { not: "0" } },
    }),
    prisma.token.count({
      where: { chain: "STARKNET", contractAddress: collection },
    }),
  ]);

  return c.json({ data: { mintedByWallet, totalMinted } });
});

// POST /v1/drop/conditions
// Store claim conditions after a successful create_drop transaction.
// Body: { collectionAddress, maxSupply, price, paymentToken, startTime, endTime, maxPerWallet }
drop.post("/conditions", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !body.collectionAddress) {
    return c.json({ error: "collectionAddress required" }, 400);
  }

  const {
    collectionAddress: rawAddress,
    maxSupply,
    price = "0",
    paymentToken = "0x0",
    startTime,
    endTime,
    maxPerWallet = "1",
  } = body;

  if (!maxSupply || startTime == null || endTime == null) {
    return c.json({ error: "maxSupply, startTime, endTime required" }, 400);
  }

  const collectionAddress = normalizeAddress(rawAddress);

  const conditions = await prisma.dropClaimConditions.upsert({
    where: { chain_collectionAddress: { chain: "STARKNET", collectionAddress } },
    create: {
      chain: "STARKNET",
      collectionAddress,
      maxSupply: String(maxSupply),
      price: String(price),
      paymentToken: paymentToken === "0x0" ? "0x0" : normalizeAddress(paymentToken),
      startTime: BigInt(startTime),
      endTime: BigInt(endTime),
      maxPerWallet: String(maxPerWallet),
    },
    update: {
      maxSupply: String(maxSupply),
      price: String(price),
      paymentToken: paymentToken === "0x0" ? "0x0" : normalizeAddress(paymentToken),
      startTime: BigInt(startTime),
      endTime: BigInt(endTime),
      maxPerWallet: String(maxPerWallet),
    },
  });

  log.info({ collectionAddress }, "Drop conditions stored");
  return c.json(
    {
      data: {
        ...conditions,
        startTime: conditions.startTime.toString(),
        endTime: conditions.endTime.toString(),
      },
    },
    201
  );
});

// GET /v1/drop/:contract/info
// Returns collection metadata merged with claim conditions.
drop.get("/:contract/info", async (c) => {
  const contractAddress = normalizeAddress(c.req.param("contract"));

  const [collection, conditions] = await Promise.all([
    prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    }),
    prisma.dropClaimConditions.findUnique({
      where: { chain_collectionAddress: { chain: "STARKNET", collectionAddress: contractAddress } },
    }),
  ]);

  if (!collection) {
    return c.json({ error: "Drop not found" }, 404);
  }

  return c.json({
    data: {
      contractAddress: collection.contractAddress,
      name: collection.name,
      symbol: collection.symbol,
      description: collection.description,
      image: collection.image,
      owner: collection.owner,
      totalMinted: collection.totalSupply,
      conditions: conditions
        ? {
            maxSupply: conditions.maxSupply,
            price: conditions.price,
            paymentToken: conditions.paymentToken,
            startTime: conditions.startTime.toString(),
            endTime: conditions.endTime.toString(),
            maxPerWallet: conditions.maxPerWallet,
          }
        : null,
    },
  });
});

export default drop;
