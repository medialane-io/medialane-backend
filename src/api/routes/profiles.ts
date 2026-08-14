import { IDENTITY_SCHEME } from "../../utils/identity.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { parseSingleChain } from "../utils/chainFilter.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { holdsToken } from "../../chainRead/index.js";
import { identityAuth } from "../middleware/identityAuth.js";
import {
  ensureAccountForWallet,
  resolveAccountIdFromWallet,
  addAccountRole,
} from "../../utils/account.js";
import { createLogger } from "../../utils/logger.js";
import { env } from "../../config/env.js";
import { serializeCreatorProfile } from "../utils/serialize.js";
import { secretMatches } from "../middleware/adminSecretAuth.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:profiles");

const profiles = new Hono<AppEnv>();

const urlField = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z
    .string()
    .url()
    .refine((v) => v.startsWith("https://") || v.startsWith("http://"), {
      message: "URL must use http or https scheme",
    })
    .nullable()
    .optional(),
);

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
  websiteUrl: urlField,
  twitterUrl: urlField,
  discordUrl: urlField,
  telegramUrl: urlField,
});

profiles.get("/collections/:contract/profile", async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const contract = normalizeAddress(chain, c.req.param("contract"));

  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress: contract } },
  });
  if (!collection) return c.json({ error: "Collection not found" }, 404);

  const profile = await prisma.collectionProfile.findUnique({
    where: { chain_contractAddress: { chain, contractAddress: contract } },
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

    const key = c.req.header("x-api-key") ?? "";
    if (secretMatches(key, env.API_SECRET_KEY)) {
      c.set("isAdmin", true);
      return next();
    }

    return identityAuth(c, next);
  },
  zValidator("json", collectionProfileSchema),
  async (c) => {
    const contract = normalizeAddress("STARKNET", c.req.param("contract"));
    const data = c.req.valid("json");
    const isAdmin = c.get("isAdmin");

    const collection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
    });
    if (!collection) return c.json({ error: "Collection not found — register the collection first" }, 404);

    if (!isAdmin) {
      const jwtWallet = c.get("walletAddress") as string;
      if (!collection.claimedBy || normalizeAddress("STARKNET", collection.claimedBy) !== jwtWallet) {
        return c.json({ error: "Not authorized to edit this collection. Collections with no claimer can only be updated via admin API key." }, 403);
      }
    }

    const updatedBy = isAdmin ? "admin" : (c.get("walletAddress") as string);

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

profiles.get(
  "/collections/:contract/gated-content",
  async (c, next) => identityAuth(c, next),
  async (c) => {
    const contract = normalizeAddress("STARKNET", c.req.param("contract"));
    const walletAddress = c.get("walletAddress") as string;

    const collection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
      select: { standard: true },
    });
    if (!collection) {
      return c.json({ error: "Collection not indexed" }, 404);
    }
    if (collection.standard !== "ERC721" && collection.standard !== "ERC1155") {
      return c.json({ error: "Unsupported collection standard for gated content" }, 400);
    }

    let knownTokenIds: string[] | undefined;
    if (collection.standard === "ERC1155") {
      const tokens = await prisma.token.findMany({
        where: { chain: "STARKNET", contractAddress: contract },
        select: { tokenId: true },
        take: 100,
      });
      knownTokenIds = tokens.map((t) => t.tokenId);
    }

    let isHolder: boolean;
    try {

      isHolder = await holdsToken("STARKNET", contract, walletAddress, collection.standard, knownTokenIds);
    } catch (err) {
      log.warn({ err, contract, walletAddress }, "Gated-content on-chain check failed");
      return c.json({ error: "Could not verify ownership on-chain, please retry" }, 503);
    }

    if (!isHolder) {
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

  const [total, profilesPage] = await Promise.all([
    prisma.accountProfile.count({ where }),
    prisma.accountProfile.findMany({
      where,
      include: {
        account: { include: { identities: { where: { scheme: IDENTITY_SCHEME.WALLET, isPrimary: true }, take: 1 } } },
      },
      orderBy: { username: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const creators = profilesPage
    .filter((p) => p.account.identities[0]?.address)
    .map((p) => serializeCreatorProfile(p, p.account.identities[0]!.address!));

  const needsImage = creators.filter((c) => !c.avatarImage);
  const collectionImageMap = new Map<string, string>();

  if (needsImage.length > 0) {
    const wallets = needsImage.map((c) => c.walletAddress);

    const rows = await prisma.$queryRaw<{ owner: string; image: string }[]>`
      SELECT DISTINCT ON (owner) owner, image
      FROM "Collection"
      WHERE owner = ANY(${wallets}::text[])
        AND image IS NOT NULL
      ORDER BY owner, "createdAt" DESC
    `;
    for (const row of rows) {
      collectionImageMap.set(row.owner, row.image);
    }
  }

  const enriched = creators.map((c) => ({
    ...c,
    collectionImage: !c.avatarImage
      ? (collectionImageMap.get(c.walletAddress) ?? null)
      : null,
  }));

  return c.json({ creators: enriched, total, page, limit });
});

profiles.get("/creators/by-username/:username", async (c) => {
  const username = c.req.param("username").toLowerCase().trim();
  const profile = await prisma.accountProfile.findUnique({
    where: { username },
    include: {
      account: { include: { identities: { where: { scheme: IDENTITY_SCHEME.WALLET, isPrimary: true }, take: 1 } } },
    },
  });
  if (!profile || !profile.account.identities[0]?.address) {
    return c.json({ error: "Creator not found" }, 404);
  }
  return c.json(serializeCreatorProfile(profile, profile.account.identities[0].address));
});

profiles.get("/creators/:wallet/hidden", async (c) => {
  const normalizedAddress = normalizeAddress("STARKNET", c.req.param("wallet"));
  const row = await prisma.hiddenCreator.findUnique({
    where: { chain_address: { chain: "STARKNET", address: normalizedAddress } },
  });
  return c.json({ isHidden: row !== null });
});

profiles.get("/creators/:wallet/profile", async (c) => {
  const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));
  const accountId = await resolveAccountIdFromWallet("STARKNET", wallet);
  if (!accountId) return c.json(null);
  const profile = await prisma.accountProfile.findUnique({ where: { accountId } });
  if (!profile) return c.json(null);
  return c.json({ chain: "STARKNET", ...serializeCreatorProfile(profile, wallet) });
});

profiles.patch(
  "/creators/:wallet/profile",
  identityAuth,
  zValidator("json", creatorProfileSchema),
  async (c) => {
    const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));
    const jwtWallet = c.get("walletAddress") as string;
    const data = c.req.valid("json");

    if (jwtWallet !== wallet) {
      return c.json({ error: "Not authorized to edit this profile" }, 403);
    }

    const { accountId } = await ensureAccountForWallet({
      chain: "STARKNET",
      address: wallet,
      appSource: "MEDIALANE_STARKNET",
    });

    await addAccountRole(accountId, "CREATOR");

    const profile = await prisma.accountProfile.upsert({
      where: { accountId },
      create: { accountId, ...data },
      update: { ...data },
    });

    return c.json({ chain: "STARKNET", ...serializeCreatorProfile(profile, wallet) });
  }
);

export default profiles;
