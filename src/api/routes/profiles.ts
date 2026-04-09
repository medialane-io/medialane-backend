import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { clerkAuth, clerkJwtOnly } from "../middleware/clerkAuth.js";
import { env } from "../../config/env.js";
import type { AppEnv } from "../../types/hono.js";

const profiles = new Hono<AppEnv>();

// Validates a URL field: must be http/https when present, null is allowed (clears the field).
const urlField = z
  .string()
  .url()
  .refine((v) => v.startsWith("https://") || v.startsWith("http://"), {
    message: "URL must use http or https scheme",
  })
  .nullable()
  .optional();

const collectionProfileSchema = z.object({
  displayName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  bannerImage: z.string().nullable().optional(),
  websiteUrl: urlField,
  twitterUrl: urlField,
  discordUrl: urlField,
  telegramUrl: urlField,
  gatedContentTitle: z.string().max(100).nullable().optional(),
  gatedContentUrl: urlField,
  gatedContentType: z.enum(["VIDEO", "STREAM", "AUDIO", "DOCUMENT", "LINK"]).nullable().optional(),
});

const creatorProfileSchema = z.object({
  displayName: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  avatarImage: z.string().nullable().optional(),
  bannerImage: z.string().nullable().optional(),
  websiteUrl: urlField,
  twitterUrl: urlField,
  discordUrl: urlField,
  telegramUrl: urlField,
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
    select: {
      id: true, contractAddress: true, chain: true,
      displayName: true, description: true, image: true, bannerImage: true,
      websiteUrl: true, twitterUrl: true, discordUrl: true, telegramUrl: true,
      hasGatedContent: true, gatedContentTitle: true, updatedBy: true, createdAt: true, updatedAt: true,
    },
  });
  return c.json(profile);
});

profiles.patch(
  "/collections/:contract/profile",
  async (c, next) => {
    // Admin key path: timing-safe comparison against API_SECRET_KEY
    const key = c.req.header("x-api-key") ?? "";
    const secretBuf = Buffer.from(env.API_SECRET_KEY);
    const keyBuf = Buffer.from(key);
    const isAdminKey =
      keyBuf.length === secretBuf.length && timingSafeEqual(keyBuf, secretBuf);
    if (isAdminKey) {
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

    const hasGatedContent = data.gatedContentUrl != null
      ? data.gatedContentUrl.length > 0
      : undefined;

    const profile = await prisma.collectionProfile.upsert({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
      create: {
        contractAddress: contract,
        chain: "STARKNET",
        ...data,
        hasGatedContent: !!(data.gatedContentUrl),
        updatedBy,
      },
      update: {
        ...data,
        ...(hasGatedContent !== undefined ? { hasGatedContent } : {}),
        updatedBy,
      },
      select: {
        id: true, contractAddress: true, chain: true,
        displayName: true, description: true, image: true, bannerImage: true,
        websiteUrl: true, twitterUrl: true, discordUrl: true, telegramUrl: true,
        hasGatedContent: true, gatedContentTitle: true, updatedBy: true, createdAt: true, updatedAt: true,
      },
    });

    return c.json(profile);
  }
);

// ─── Gated Content (holder-only) ─────────────────────────────────────────────

profiles.get(
  "/collections/:contract/gated-content",
  async (c, next) => clerkJwtOnly(c, next),
  async (c) => {
    const contract = normalizeAddress(c.req.param("contract"));
    const walletAddress = c.get("clerkWallet") as string;

    // Check if this wallet holds at least one token in the collection (ERC-721 or ERC-1155)
    const ownedToken = await prisma.tokenBalance.findFirst({
      where: { chain: "STARKNET", contractAddress: contract, owner: walletAddress, amount: { not: "0" } },
      select: { id: true },
    });

    if (!ownedToken) {
      return c.json({ error: "Not a holder of this collection" }, 403);
    }

    const profile = await prisma.collectionProfile.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
      select: {
        hasGatedContent: true,
        gatedContentTitle: true,
        gatedContentUrl: true,
        gatedContentType: true,
      },
    });

    if (!profile?.hasGatedContent || !profile.gatedContentUrl) {
      return c.json({ error: "No gated content available for this collection" }, 404);
    }

    return c.json({
      title: profile.gatedContentTitle,
      url: profile.gatedContentUrl,
      type: profile.gatedContentType,
    });
  }
);

// ─── Creators List (public read) ─────────────────────────────────────────────
// Lists all creator profiles that have an approved username. Supports search + pagination.

profiles.get("/creators", async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const search = c.req.query("search")?.trim().toLowerCase() ?? "";

  const where = {
    username: { not: null as null },
    ...(search ? {
      OR: [
        { username:    { contains: search, mode: "insensitive" as const } },
        { displayName: { contains: search, mode: "insensitive" as const } },
      ],
    } : {}),
  };

  const [total, creators] = await Promise.all([
    prisma.creatorProfile.count({ where }),
    prisma.creatorProfile.findMany({
      where,
      select: {
        walletAddress: true, username: true, displayName: true, bio: true,
        avatarImage: true, bannerImage: true, websiteUrl: true,
        twitterUrl: true, discordUrl: true, telegramUrl: true,
      },
      orderBy: { username: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return c.json({ creators, total, page, limit });
});

// ─── Creator by Username (public read) ───────────────────────────────────────
// Resolves a username slug to a wallet address + profile. Used by /creator/[username].

profiles.get("/creators/by-username/:username", async (c) => {
  const username = c.req.param("username").toLowerCase().trim();
  const profile = await prisma.creatorProfile.findUnique({
    where: { username },
    select: {
      walletAddress: true, username: true, displayName: true, bio: true,
      avatarImage: true, bannerImage: true, websiteUrl: true,
      twitterUrl: true, discordUrl: true, telegramUrl: true,
    },
  });
  if (!profile) return c.json({ error: "Creator not found" }, 404);
  return c.json(profile);
});

// ─── Creator Hidden Indicator (public read) ──────────────────────────────────

profiles.get("/creators/:wallet/hidden", async (c) => {
  const normalizedAddress = normalizeAddress(c.req.param("wallet"));
  const row = await prisma.hiddenCreator.findUnique({
    where: { chain_address: { chain: "STARKNET", address: normalizedAddress } },
  });
  return c.json({ isHidden: row !== null });
});

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
