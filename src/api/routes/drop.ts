import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { clerkJwtOnly } from "../middleware/clerkAuth.js";
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

const conditionsSchema = z.object({
  collectionAddress: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid collection address"),
  maxSupply: z.string().regex(/^\d+$/, "maxSupply must be a non-negative integer string"),
  price: z.string().regex(/^\d+$/, "price must be a non-negative integer string").default("0"),
  paymentToken: z.string().default("0x0"),
  startTime: z.number().int().nonnegative("startTime must be a non-negative integer"),
  endTime: z.number().int().nonnegative("endTime must be a non-negative integer"),
  maxPerWallet: z.string().regex(/^\d+$/, "maxPerWallet must be a non-negative integer string").default("1"),
});

// POST /v1/drop/conditions
// Store claim conditions after a successful create_drop transaction.
// Requires Clerk JWT — only the collection owner (claimedBy or owner field) may set conditions.
// Body: { collectionAddress, maxSupply, price, paymentToken, startTime, endTime, maxPerWallet }
drop.post("/conditions", async (c, next) => clerkJwtOnly(c, next), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid request body" }, 400);

  const parsed = conditionsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }
  const data = parsed.data;

  const collectionAddress = normalizeAddress(data.collectionAddress);
  const callerWallet = c.get("clerkWallet") as string | undefined;

  // Ownership check: caller must match the collection owner or claimedBy wallet
  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: collectionAddress } },
    select: { owner: true, claimedBy: true },
  });

  if (!collection) {
    return c.json({ error: "Collection not found" }, 404);
  }

  const ownerMatch = collection.owner && callerWallet &&
    normalizeAddress(collection.owner) === callerWallet;
  const claimedByMatch = collection.claimedBy && callerWallet &&
    normalizeAddress(collection.claimedBy) === callerWallet;

  if (!ownerMatch && !claimedByMatch) {
    return c.json({ error: "Not authorized to set conditions for this collection" }, 403);
  }

  const paymentToken = data.paymentToken === "0x0" ? "0x0" : normalizeAddress(data.paymentToken);

  const conditions = await prisma.dropClaimConditions.upsert({
    where: { chain_collectionAddress: { chain: "STARKNET", collectionAddress } },
    create: {
      chain: "STARKNET",
      collectionAddress,
      maxSupply: data.maxSupply,
      price: data.price,
      paymentToken,
      startTime: BigInt(data.startTime),
      endTime: BigInt(data.endTime),
      maxPerWallet: data.maxPerWallet,
    },
    update: {
      maxSupply: data.maxSupply,
      price: data.price,
      paymentToken,
      startTime: BigInt(data.startTime),
      endTime: BigInt(data.endTime),
      maxPerWallet: data.maxPerWallet,
    },
  });

  log.info({ collectionAddress, callerWallet }, "Drop conditions stored");
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
