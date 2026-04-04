import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { clerkAuth } from "../middleware/clerkAuth.js";
import type { AppEnv } from "../../types/hono.js";
import { SUPPORTED_TOKENS, getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:remix-offers");

const remixOffers = new Hono<AppEnv>();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createOfferSchema = z.object({
  originalContract: z.string().min(1),
  originalTokenId: z.string().min(1),
  proposedPrice: z.string().min(1),
  proposedCurrency: z.string().min(1),
  licenseType: z.string().min(1).max(100),
  commercial: z.boolean().default(false),
  derivatives: z.boolean().default(true),
  royaltyPct: z.number().int().min(0).max(100).optional(),
  message: z.string().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
});

const autoOfferSchema = z.object({
  originalContract: z.string().min(1),
  originalTokenId: z.string().min(1),
});

const selfConfirmSchema = z.object({
  originalContract: z.string().min(1),
  originalTokenId: z.string().min(1),
  remixContract: z.string().min(1),
  remixTokenId: z.string().min(1),
  txHash: z.string().min(1),
  licenseType: z.string().min(1).max(100),
  commercial: z.boolean().default(false),
  derivatives: z.boolean().default(true),
  royaltyPct: z.number().int().min(0).max(100).optional(),
});

const confirmSchema = z.object({
  remixContract: z.string().min(1),
  remixTokenId: z.string().min(1),
  approvedCollection: z.string().min(1),
  orderHash: z.string().min(1),
});

const listSchema = z.object({
  role: z.enum(["creator", "requester"]).default("creator"),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse "License Price" attribute format: "<amount> <SYMBOL>" → { price, currencyAddress } */
function parseLicensePrice(value: string): { price: string; currencyAddress: string } | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [amount, symbol] = parts;
  const token = SUPPORTED_TOKENS.find(
    (t) => t.symbol.toUpperCase() === symbol.toUpperCase()
  );
  if (!token || isNaN(parseFloat(amount))) return null;
  // Convert human-readable amount to raw wei
  const raw = BigInt(Math.round(parseFloat(amount) * 10 ** token.decimals)).toString();
  return { price: raw, currencyAddress: token.address };
}

/** Serialise a RemixOffer for API response — no sensitive fields for non-participants. */
function serializeOffer(offer: any, callerWallet?: string) {
  const isParticipant =
    !callerWallet ||
    offer.creatorAddress === callerWallet ||
    offer.requesterAddress === callerWallet;

  let price: object | undefined;
  if (isParticipant && offer.proposedPrice && offer.proposedCurrency) {
    const token = getTokenByAddress(offer.proposedCurrency);
    price = token
      ? {
          raw: offer.proposedPrice,
          formatted: formatAmount(offer.proposedPrice, token.decimals),
          currency: token.symbol,
          decimals: token.decimals,
        }
      : { raw: offer.proposedPrice, formatted: offer.proposedPrice, currency: "TOKEN", decimals: 18 };
  }

  return {
    id: offer.id,
    status: offer.status,
    originalContract: offer.originalContract,
    originalTokenId: offer.originalTokenId,
    creatorAddress: offer.creatorAddress,
    requesterAddress: offer.requesterAddress,
    licenseType: offer.licenseType,
    commercial: offer.commercial,
    derivatives: offer.derivatives,
    royaltyPct: offer.royaltyPct,
    ...(isParticipant ? { price, message: offer.message } : {}),
    approvedCollection: offer.approvedCollection,
    remixContract: offer.remixContract,
    remixTokenId: offer.remixTokenId,
    orderHash: offer.orderHash,
    createdAt: offer.createdAt,
    expiresAt: offer.expiresAt,
    updatedAt: offer.updatedAt,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** POST /v1/remix-offers — submit a custom license offer */
remixOffers.post(
  "/",

  (c, next) => clerkAuth(c, next),
  zValidator("json", createOfferSchema),
  async (c) => {
    const body = c.req.valid("json");
    const requesterAddress = c.get("clerkWallet") as string;

    const originalContract = normalizeAddress(body.originalContract);
    const originalTokenId = body.originalTokenId;

    // Look up token to get creator address
    const token = await prisma.token.findFirst({
      where: { contractAddress: originalContract, tokenId: originalTokenId },
      select: { owner: true },
    });
    if (!token) return c.json({ error: "Token not found or not yet indexed" }, 404);

    const creatorAddress = normalizeAddress(token.owner ?? "");
    if (!creatorAddress) return c.json({ error: "Token owner unknown" }, 422);

    // Owner cannot offer on their own token
    if (requesterAddress === creatorAddress) {
      return c.json({ error: "Use the self-remix endpoint for your own tokens" }, 400);
    }

    // Dedup: no active offer from same requester for same token
    const existing = await prisma.remixOffer.findFirst({
      where: {
        originalContract,
        originalTokenId,
        requesterAddress,
        status: { in: ["PENDING", "AUTO_PENDING", "APPROVED"] },
      },
    });
    if (existing) return c.json({ error: "Active offer already exists" }, 409);

    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    const offer = await prisma.remixOffer.create({
      data: {
        status: "PENDING",
        originalContract,
        originalTokenId,
        creatorAddress,
        requesterAddress,
        message: body.message,
        proposedPrice: body.proposedPrice,
        proposedCurrency: normalizeAddress(body.proposedCurrency),
        licenseType: body.licenseType,
        commercial: body.commercial,
        derivatives: body.derivatives,
        royaltyPct: body.royaltyPct,
        expiresAt,
      },
    });

    log.info({ id: offer.id, requesterAddress, creatorAddress }, "Remix offer created");
    return c.json({ data: serializeOffer(offer, requesterAddress) }, 201);
  }
);

/** POST /v1/remix-offers/auto — instant offer for open-license assets */
remixOffers.post(
  "/auto",

  (c, next) => clerkAuth(c, next),
  zValidator("json", autoOfferSchema),
  async (c) => {
    const body = c.req.valid("json");
    const requesterAddress = c.get("clerkWallet") as string;

    const originalContract = normalizeAddress(body.originalContract);
    const originalTokenId = body.originalTokenId;

    const token = await prisma.token.findFirst({
      where: { contractAddress: originalContract, tokenId: originalTokenId },
      select: { owner: true, attributes: true },
    });
    if (!token) return c.json({ error: "Token not found or not yet indexed" }, 422);

    // Parse license and price from token attributes
    const attrs = token.attributes as Array<{ trait_type: string; value: string }> | undefined;
    if (!attrs) return c.json({ error: "Token has no metadata attributes" }, 422);

    const OPEN_LICENSES = ["CC0", "CC BY", "CC BY-SA", "CC BY-NC"];
    const licenseAttr = attrs.find((a) => a.trait_type === "License");
    if (!licenseAttr || !OPEN_LICENSES.includes(licenseAttr.value)) {
      return c.json({ error: "Token does not have an open license" }, 422);
    }

    const priceAttr = attrs.find((a) => a.trait_type === "License Price");
    if (!priceAttr) return c.json({ error: "Token has no License Price attribute" }, 422);

    const parsed = parseLicensePrice(priceAttr.value);
    if (!parsed) {
      return c.json({ error: `Invalid License Price format: "${priceAttr.value}". Expected "<amount> <SYMBOL>" e.g. "0.5 STRK"` }, 422);
    }

    const creatorAddress = normalizeAddress(token.owner ?? "");
    if (!creatorAddress) return c.json({ error: "Token owner unknown" }, 422);
    if (requesterAddress === creatorAddress) {
      return c.json({ error: "You own this token; use the self-remix endpoint" }, 400);
    }

    const existing = await prisma.remixOffer.findFirst({
      where: {
        originalContract,
        originalTokenId,
        requesterAddress,
        status: { in: ["PENDING", "AUTO_PENDING", "APPROVED"] },
      },
    });
    if (existing) return c.json({ error: "Active offer already exists" }, 409);

    // Terms from token attributes
    const commercialAttr = attrs.find((a) => a.trait_type === "Commercial Use");
    const derivativesAttr = attrs.find((a) => a.trait_type === "Derivatives");
    const royaltyAttr = attrs.find((a) => a.trait_type === "Royalty");
    const royaltyPct = royaltyAttr
      ? parseInt(royaltyAttr.value.replace("%", ""), 10) || undefined
      : undefined;

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days default

    const offer = await prisma.remixOffer.create({
      data: {
        status: "AUTO_PENDING",
        originalContract,
        originalTokenId,
        creatorAddress,
        requesterAddress,
        proposedPrice: parsed.price,
        proposedCurrency: parsed.currencyAddress,
        licenseType: licenseAttr.value,
        commercial: commercialAttr?.value?.toLowerCase() === "yes",
        derivatives: derivativesAttr?.value?.toLowerCase() !== "no",
        royaltyPct: isNaN(royaltyPct!) ? undefined : royaltyPct,
        expiresAt,
      },
    });

    log.info({ id: offer.id, requesterAddress, creatorAddress }, "Auto remix offer created");
    return c.json({ data: serializeOffer(offer, requesterAddress) }, 201);
  }
);

/** POST /v1/remix-offers/self/confirm — record completed owner self-remix */
remixOffers.post(
  "/self/confirm",

  (c, next) => clerkAuth(c, next),
  zValidator("json", selfConfirmSchema),
  async (c) => {
    const body = c.req.valid("json");
    const walletAddress = c.get("clerkWallet") as string;

    const originalContract = normalizeAddress(body.originalContract);
    const originalTokenId = body.originalTokenId;

    // Verify caller owns the original token
    const token = await prisma.token.findFirst({
      where: { contractAddress: originalContract, tokenId: originalTokenId },
      select: { owner: true },
    });
    if (!token) return c.json({ error: "Token not found" }, 404);

    const ownerAddress = normalizeAddress(token.owner ?? "");
    if (ownerAddress !== walletAddress) {
      return c.json({ error: "You do not own this token" }, 403);
    }

    const offer = await prisma.remixOffer.create({
      data: {
        status: "SELF_MINTED",
        originalContract,
        originalTokenId,
        creatorAddress: walletAddress,
        proposedPrice: "0",
        proposedCurrency: "0x0000000000000000000000000000000000000000000000000000000000000000",
        licenseType: body.licenseType,
        commercial: body.commercial,
        derivatives: body.derivatives,
        royaltyPct: body.royaltyPct,
        remixContract: normalizeAddress(body.remixContract),
        remixTokenId: body.remixTokenId,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year sentinel
      },
    });

    log.info({ id: offer.id, walletAddress }, "Self-remix recorded");
    return c.json({ data: serializeOffer(offer, walletAddress) }, 201);
  }
);

/** POST /v1/remix-offers/:id/confirm — record completed mint + listing (Paths 2 & 3) */
remixOffers.post(
  "/:id/confirm",

  (c, next) => clerkAuth(c, next),
  zValidator("json", confirmSchema),
  async (c) => {
    const { id } = c.req.param();
    const body = c.req.valid("json");
    const walletAddress = c.get("clerkWallet") as string;

    const offer = await prisma.remixOffer.findUnique({ where: { id } });
    if (!offer) return c.json({ error: "Offer not found" }, 404);
    if (offer.creatorAddress !== walletAddress) {
      return c.json({ error: "Only the creator can confirm this offer" }, 403);
    }
    if (!["PENDING", "AUTO_PENDING"].includes(offer.status)) {
      return c.json({ error: `Cannot confirm offer with status ${offer.status}` }, 409);
    }

    const updated = await prisma.remixOffer.update({
      where: { id },
      data: {
        status: "APPROVED",
        remixContract: normalizeAddress(body.remixContract),
        remixTokenId: body.remixTokenId,
        approvedCollection: normalizeAddress(body.approvedCollection),
        orderHash: body.orderHash,
      },
    });

    log.info({ id, remixContract: body.remixContract, orderHash: body.orderHash }, "Remix offer confirmed");
    return c.json({ data: serializeOffer(updated, walletAddress) });
  }
);

/** POST /v1/remix-offers/:id/reject */
remixOffers.post(
  "/:id/reject",

  (c, next) => clerkAuth(c, next),
  async (c) => {
    const { id } = c.req.param();
    const walletAddress = c.get("clerkWallet") as string;

    const offer = await prisma.remixOffer.findUnique({ where: { id } });
    if (!offer) return c.json({ error: "Offer not found" }, 404);
    if (offer.creatorAddress !== walletAddress) {
      return c.json({ error: "Only the creator can reject this offer" }, 403);
    }
    if (!["PENDING", "AUTO_PENDING"].includes(offer.status)) {
      return c.json({ error: `Cannot reject offer with status ${offer.status}` }, 409);
    }

    const updated = await prisma.remixOffer.update({
      where: { id },
      data: { status: "REJECTED" },
    });

    log.info({ id, walletAddress }, "Remix offer rejected");
    return c.json({ data: serializeOffer(updated, walletAddress) });
  }
);

/** POST /v1/remix-offers/:id/extend — requester extends expiry of a pending offer */
remixOffers.post(
  "/:id/extend",

  (c, next) => clerkAuth(c, next),
  async (c) => {
    const { id } = c.req.param();
    const walletAddress = c.get("clerkWallet") as string;

    const body = await c.req.json().catch(() => null);
    const days = Number(body?.days);
    if (!days || days < 1 || days > 30) {
      return c.json({ error: "days must be between 1 and 30" }, 400);
    }

    const offer = await prisma.remixOffer.findUnique({ where: { id } });
    if (!offer) return c.json({ error: "Offer not found" }, 404);
    if (offer.requesterAddress !== walletAddress) {
      return c.json({ error: "Only the requester can extend this offer" }, 403);
    }
    if (!["PENDING", "AUTO_PENDING"].includes(offer.status)) {
      return c.json({ error: `Cannot extend offer with status ${offer.status}` }, 409);
    }

    const baseDate = offer.expiresAt > new Date() ? offer.expiresAt : new Date();
    const newExpiresAt = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

    const updated = await prisma.remixOffer.update({
      where: { id },
      data: { expiresAt: newExpiresAt },
    });

    log.info({ id, walletAddress, newExpiresAt }, "Remix offer extended");
    return c.json({ data: serializeOffer(updated, walletAddress) });
  }
);

/** GET /v1/remix-offers — list offers for authenticated user */
remixOffers.get(
  "/",

  (c, next) => clerkAuth(c, next),
  zValidator("query", listSchema),
  async (c) => {
    const { role, status, page, limit } = c.req.valid("query");
    const walletAddress = c.get("clerkWallet") as string;

    const where: any = {
      ...(role === "creator" ? { creatorAddress: walletAddress } : { requesterAddress: walletAddress }),
      ...(status ? { status: status as any } : {}),
    };

    const [offers, total] = await Promise.all([
      prisma.remixOffer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.remixOffer.count({ where }),
    ]);

    return c.json({
      data: offers.map((o) => serializeOffer(o, walletAddress)),
      meta: { page, limit, total },
    });
  }
);

/** GET /v1/remix-offers/:id — single offer, public */
remixOffers.get("/:id", async (c) => {
  const { id } = c.req.param();
  // Try to resolve caller if Clerk token is present (for participant check)
  let callerWallet: string | undefined;
  try {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      // Soft-resolve — ignore errors for unauthenticated callers
      await clerkAuth(c, async () => {});
      callerWallet = c.get("clerkWallet") as string | undefined;
    }
  } catch { /* not authenticated — show public fields only */ }

  const offer = await prisma.remixOffer.findUnique({ where: { id } });
  if (!offer) return c.json({ error: "Offer not found" }, 404);

  return c.json({ data: serializeOffer(offer, callerWallet) });
});

export default remixOffers;
