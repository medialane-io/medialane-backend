import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { validateSlugLike } from "../../utils/slugClaim.js";
import type { AppEnv } from "../../types/hono.js";

const collectionSlugClaims = new Hono<AppEnv>();

function validateSlug(slug: string): string | null {
  return validateSlugLike(slug, "slug");
}

// ─── GET /v1/collection-slug-claims/check/:slug ───────────────────────────────
// Public availability check — no auth required.

collectionSlugClaims.get("/check/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase().trim();

  const validationError = validateSlug(slug);
  if (validationError) return c.json({ available: false, reason: validationError });

  const [takenProfile, pendingClaim] = await Promise.all([
    prisma.collectionProfile.findUnique({ where: { slug }, select: { contractAddress: true } }),
    prisma.collectionSlugClaim.findFirst({ where: { slug, status: { in: ["PENDING", "APPROVED"] } } }),
  ]);

  if (takenProfile || pendingClaim) {
    return c.json({ available: false, reason: "That slug is already taken." });
  }

  return c.json({ available: true });
});

// ─── POST /v1/collection-slug-claims ─────────────────────────────────────────
// Submit a slug claim for a collection. Caller must be the collection owner.
// Auth: tenant API key (global apiKeyGate) + Clerk JWT.

collectionSlugClaims.post(
  "/",
  identityAuth,
  zValidator("json", z.object({
    contractAddress: z.string(),
    slug: z.string(),
    notifyEmail: z.string().email().optional(),
  })),
  async (c) => {
    const jwtWallet = c.get("walletAddress") as string;
    const { contractAddress, slug: rawSlug, notifyEmail } = c.req.valid("json");
    const normContract = normalizeAddress("STARKNET", contractAddress);
    const slug = rawSlug.toLowerCase().trim();

    const validationError = validateSlug(slug);
    if (validationError) return c.json({ error: validationError }, 400);

    // Verify caller is the collection owner
    const collection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
      select: { owner: true, claimedBy: true, profile: { select: { slug: true } } },
    });
    if (!collection) return c.json({ error: "Collection not found." }, 404);

    const isOwner =
      (collection.owner && normalizeAddress("STARKNET", collection.owner) === jwtWallet) ||
      (collection.claimedBy && normalizeAddress("STARKNET", collection.claimedBy) === jwtWallet);
    if (!isOwner) return c.json({ error: "Only the collection owner can claim a slug." }, 403);

    // Collection already has an approved slug
    if (collection.profile?.slug) {
      return c.json({ error: "This collection already has an approved slug." }, 409);
    }

    // Already has a pending claim for this collection
    const pendingFromContract = await prisma.collectionSlugClaim.findFirst({
      where: { contractAddress: normContract, status: "PENDING" },
    });
    if (pendingFromContract) {
      return c.json({
        error: "This collection already has a pending slug claim. Wait for it to be reviewed before submitting another.",
      }, 409);
    }

    // Check if slug is taken (approved profile or pending/approved claim)
    const takenProfile = await prisma.collectionProfile.findUnique({
      where: { slug },
      select: { contractAddress: true },
    });
    if (takenProfile) return c.json({ error: "That slug is already taken." }, 409);

    const pendingClaim = await prisma.collectionSlugClaim.findFirst({
      where: { slug, status: { in: ["PENDING", "APPROVED"] } },
    });
    if (pendingClaim) return c.json({ error: "That slug is already claimed or pending review." }, 409);

    const claim = await prisma.collectionSlugClaim.create({
      data: {
        slug,
        contractAddress: normContract,
        chain: "STARKNET",
        walletAddress: jwtWallet,
        status: "PENDING",
        notifyEmail: notifyEmail ?? null,
      },
    });

    return c.json({ claim }, 201);
  }
);

// ─── GET /v1/collection-slug-claims/me ───────────────────────────────────────
// Returns all slug claims submitted by the authenticated wallet.

collectionSlugClaims.get(
  "/me",
  identityAuth,
  async (c) => {
    const jwtWallet = c.get("walletAddress") as string;

    const claims = await prisma.collectionSlugClaim.findMany({
      where: { walletAddress: jwtWallet },
      orderBy: { createdAt: "desc" },
    });

    return c.json({ claims });
  }
);

export default collectionSlugClaims;
