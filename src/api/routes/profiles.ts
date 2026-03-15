import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { clerkAuth } from "../middleware/clerkAuth.js";
import { env } from "../../config/env.js";
import type { AppEnv } from "../../types/hono.js";

const profiles = new Hono<AppEnv>();

const collectionProfileSchema = z.object({
  displayName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  bannerImage: z.string().nullable().optional(),
  websiteUrl: z.string().nullable().optional(),
  twitterUrl: z.string().nullable().optional(),
  discordUrl: z.string().nullable().optional(),
  telegramUrl: z.string().nullable().optional(),
});

const creatorProfileSchema = z.object({
  displayName: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  avatarImage: z.string().nullable().optional(),
  bannerImage: z.string().nullable().optional(),
  websiteUrl: z.string().nullable().optional(),
  twitterUrl: z.string().nullable().optional(),
  discordUrl: z.string().nullable().optional(),
  telegramUrl: z.string().nullable().optional(),
});

// ─── Collection Profile (public read, Clerk JWT or admin key for write) ──────

profiles.get("/collections/:contract/profile", async (c) => {
  const contract = normalizeAddress(c.req.param("contract"));

  // Verify collection exists first
  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
  });
  if (!collection) return c.json({ error: "Collection not found" }, 404);

  const profile = await prisma.collectionProfile.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
  });
  return c.json(profile);
});

profiles.patch(
  "/collections/:contract/profile",
  async (c, next) => {
    // Admin key path: check x-api-key against API_SECRET_KEY
    const key = c.req.header("x-api-key");
    if (key && key === env.API_SECRET_KEY) {
      c.set("isAdmin", true);
      return next();
    }
    // Non-admin path: call clerkAuth as a plain function, passing the same c and next.
    // In Hono, `next` here IS the chain's next item (zValidator), so clerkAuth's internal
    // `await next()` correctly forwards to it.
    return clerkAuth(c, next);
  },
  zValidator("json", collectionProfileSchema),
  async (c) => {
    const contract = normalizeAddress(c.req.param("contract"));
    const data = c.req.valid("json");
    const isAdmin = c.get("isAdmin");

    const collection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
    });
    if (!collection) return c.json({ error: "Collection not found — register the collection first" }, 404);

    if (!isAdmin) {
      const jwtWallet = c.get("clerkWallet") as string;
      if (!collection.claimedBy || normalizeAddress(collection.claimedBy) !== jwtWallet) {
        return c.json({ error: "Not authorized to edit this collection. Collections with no claimer can only be updated via admin API key." }, 403);
      }
    }

    const updatedBy = isAdmin ? "admin" : (c.get("clerkWallet") as string);

    const profile = await prisma.collectionProfile.upsert({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
      create: { contractAddress: contract, chain: "STARKNET", ...data, updatedBy },
      update: { ...data, updatedBy },
    });

    return c.json(profile);
  }
);

// ─── Creator Profile (public read, Clerk JWT for write) ─────────────────────

profiles.get("/creators/:wallet/profile", async (c) => {
  const wallet = normalizeAddress(c.req.param("wallet"));
  const profile = await prisma.creatorProfile.findUnique({ where: { walletAddress: wallet } });
  return c.json(profile); // null if not found — HTTP 200 per spec
});

profiles.patch(
  "/creators/:wallet/profile",
  clerkAuth,
  zValidator("json", creatorProfileSchema),
  async (c) => {
    const wallet = normalizeAddress(c.req.param("wallet"));
    const jwtWallet = c.get("clerkWallet") as string;
    const data = c.req.valid("json");

    if (jwtWallet !== wallet) {
      return c.json({ error: "Not authorized to edit this profile" }, 403);
    }

    const profile = await prisma.creatorProfile.upsert({
      where: { walletAddress: wallet },
      create: { walletAddress: wallet, chain: "STARKNET", ...data },
      update: { ...data },
    });

    return c.json(profile);
  }
);

export default profiles;
