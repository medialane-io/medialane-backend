import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { RemixOffer, RemixOfferStatus, Prisma as PrismaTypes } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { identityAuth } from "../middleware/identityAuth.js";
import type { AppEnv } from "../../types/hono.js";

import { SUPPORTED_TOKENS, getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:remix-offers");

const remixOffers = new Hono<AppEnv>();

import { createSlidingWindow } from "../../utils/slidingWindow.js";
import { verifyTransactionSucceeded, fetchReceiptEvents } from "../../utils/txVerifier.js";

const checkOfferRateLimit = createSlidingWindow(20, 60_000);

const createOfferSchema = z.object({
  originalContract: z.string().min(1),
  originalTokenId: z.string().min(1),
  proposedPrice: z.string().min(1),
  proposedCurrency: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid currency address").optional(),
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

type TokenAttr = { trait_type: string; value: string };

type OpenLicenseTerms = {
  licenseType: string;
  price: string;
  currencyAddress: string;
  commercial: boolean;
  derivatives: boolean;
  royaltyPct: number | undefined;
};

type OpenLicenseResult =
  | { ok: true; terms: OpenLicenseTerms }
  | { ok: false; error: string; status: 422 };

const OPEN_LICENSES = ["CC0", "CC BY", "CC BY-SA", "CC BY-NC"] as const;

function resolveOpenLicenseTerms(attrs: TokenAttr[]): OpenLicenseResult {
  const licenseAttr = attrs.find((a) => a.trait_type === "License");
  if (!licenseAttr || !(OPEN_LICENSES as readonly string[]).includes(licenseAttr.value)) {
    return { ok: false, error: "Token does not have an open license", status: 422 };
  }

  const priceAttr = attrs.find((a) => a.trait_type === "License Price");
  if (!priceAttr) {
    return { ok: false, error: "Token has no License Price attribute", status: 422 };
  }

  const parsed = parseLicensePrice(priceAttr.value);
  if (!parsed) {
    return {
      ok: false,
      error: `Invalid License Price format: "${priceAttr.value}". Expected "<amount> <SYMBOL>" e.g. "0.5 STRK"`,
      status: 422,
    };
  }

  const commercialAttr = attrs.find((a) => a.trait_type === "Commercial Use");
  const derivativesAttr = attrs.find((a) => a.trait_type === "Derivatives");
  const royaltyAttr = attrs.find((a) => a.trait_type === "Royalty");
  const royaltyPct = royaltyAttr
    ? parseInt(royaltyAttr.value.replace("%", ""), 10) || undefined
    : undefined;

  return {
    ok: true,
    terms: {
      licenseType: licenseAttr.value,
      price: parsed.price,
      currencyAddress: parsed.currencyAddress,
      commercial: commercialAttr?.value?.toLowerCase() === "yes",
      derivatives: derivativesAttr?.value?.toLowerCase() !== "no",
      royaltyPct: isNaN(royaltyPct!) ? undefined : royaltyPct,
    },
  };
}

function parseLicensePrice(value: string): { price: string; currencyAddress: string } | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [amount, symbol] = parts;
  const token = SUPPORTED_TOKENS.find(
    (t) => t.symbol.toUpperCase() === symbol.toUpperCase()
  );
  if (!token || isNaN(parseFloat(amount))) return null;

  const raw = BigInt(Math.round(parseFloat(amount) * 10 ** token.decimals)).toString();
  return { price: raw, currencyAddress: token.address };
}

class DuplicateOfferError extends Error {
  constructor() {
    super("Active offer already exists");
  }
}

async function loadActionableOffer(
  id: string,
  walletAddress: string,
  authField: "creatorAddress" | "requesterAddress",
  role: string,
  verb: string
): Promise<{ ok: true; offer: RemixOffer } | { ok: false; error: string; status: 404 | 403 | 409 }> {
  const offer = await prisma.remixOffer.findUnique({ where: { id } });
  if (!offer) return { ok: false, error: "Offer not found", status: 404 };
  if (offer[authField] !== walletAddress) {
    return { ok: false, error: `Only the ${role} can ${verb} this offer`, status: 403 };
  }
  if (!["PENDING", "AUTO_PENDING"].includes(offer.status)) {
    return { ok: false, error: `Cannot ${verb} offer with status ${offer.status}`, status: 409 };
  }
  return { ok: true, offer };
}

function serializeOffer(offer: RemixOffer, callerWallet?: string) {
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

remixOffers.post(
  "/",

  (c, next) => identityAuth(c, next),
  zValidator("json", createOfferSchema),
  async (c) => {
    const body = c.req.valid("json");
    const requesterAddress = c.get("walletAddress") as string;

    if (!checkOfferRateLimit(requesterAddress)) {
      return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }

    const originalContract = normalizeAddress("STARKNET", body.originalContract);
    const originalTokenId = body.originalTokenId;

    const tokenExists = await prisma.token.findFirst({
      where: { contractAddress: originalContract, tokenId: originalTokenId },
      select: { id: true },
    });
    if (!tokenExists) return c.json({ error: "Token not found or not yet indexed" }, 404);

    const holderBalance = await prisma.tokenBalance.findFirst({
      where: { contractAddress: originalContract, tokenId: originalTokenId, amount: { not: "0" } },
      select: { owner: true },
    });
    const creatorAddress = holderBalance ? normalizeAddress("STARKNET", holderBalance.owner) : "";
    if (!creatorAddress) return c.json({ error: "Token owner unknown" }, 422);

    if (requesterAddress === creatorAddress) {
      return c.json({ error: "Use the self-remix endpoint for your own tokens" }, 400);
    }

    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    let offer;
    try {
      offer = await prisma.$transaction(async (tx) => {
        const existing = await tx.remixOffer.findFirst({
          where: {
            originalContract,
            originalTokenId,
            requesterAddress,
            status: { in: ["PENDING", "AUTO_PENDING", "APPROVED"] },
          },
        });
        if (existing) throw new DuplicateOfferError();
        return tx.remixOffer.create({
          data: {
            status: "PENDING",
            originalContract,
            originalTokenId,
            creatorAddress,
            requesterAddress,
            message: body.message,
            proposedPrice: body.proposedPrice,
            proposedCurrency: body.proposedCurrency ? normalizeAddress("STARKNET", body.proposedCurrency) : "",
            licenseType: body.licenseType,
            commercial: body.commercial,
            derivatives: body.derivatives,
            royaltyPct: body.royaltyPct,
            expiresAt,
          },
        });
      });
    } catch (err: unknown) {
      if (err instanceof DuplicateOfferError) return c.json({ error: err.message }, 409);
      throw err;
    }

    log.info({ id: offer.id, requesterAddress, creatorAddress }, "Remix offer created");
    return c.json({ data: serializeOffer(offer, requesterAddress) }, 201);
  }
);

remixOffers.post(
  "/auto",

  (c, next) => identityAuth(c, next),
  zValidator("json", autoOfferSchema),
  async (c) => {
    const body = c.req.valid("json");
    const requesterAddress = c.get("walletAddress") as string;

    if (!checkOfferRateLimit(requesterAddress)) {
      return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }

    const originalContract = normalizeAddress("STARKNET", body.originalContract);
    const originalTokenId = body.originalTokenId;

    const [token, holderBalance] = await Promise.all([
      prisma.token.findFirst({
        where: { contractAddress: originalContract, tokenId: originalTokenId },
        select: { attributes: true },
      }),
      prisma.tokenBalance.findFirst({
        where: { contractAddress: originalContract, tokenId: originalTokenId, amount: { not: "0" } },
        select: { owner: true },
      }),
    ]);
    if (!token) return c.json({ error: "Token not found or not yet indexed" }, 422);

    const attrs = token.attributes as TokenAttr[] | undefined;
    if (!attrs) return c.json({ error: "Token has no metadata attributes" }, 422);

    const licenseResult = resolveOpenLicenseTerms(attrs);
    if (!licenseResult.ok) return c.json({ error: licenseResult.error }, licenseResult.status);
    const { terms } = licenseResult;

    const creatorAddress = holderBalance ? normalizeAddress("STARKNET", holderBalance.owner) : "";
    if (!creatorAddress) return c.json({ error: "Token owner unknown" }, 422);
    if (requesterAddress === creatorAddress) {
      return c.json({ error: "You own this token; use the self-remix endpoint" }, 400);
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let offer;
    try {
      offer = await prisma.$transaction(async (tx) => {
        const existing = await tx.remixOffer.findFirst({
          where: {
            originalContract,
            originalTokenId,
            requesterAddress,
            status: { in: ["PENDING", "AUTO_PENDING", "APPROVED"] },
          },
        });
        if (existing) throw new DuplicateOfferError();
        return tx.remixOffer.create({
          data: {
            status: "AUTO_PENDING",
            originalContract,
            originalTokenId,
            creatorAddress,
            requesterAddress,
            proposedPrice: terms.price,
            proposedCurrency: terms.currencyAddress,
            licenseType: terms.licenseType,
            commercial: terms.commercial,
            derivatives: terms.derivatives,
            royaltyPct: terms.royaltyPct,
            expiresAt,
          },
        });
      });
    } catch (err: unknown) {
      if (err instanceof DuplicateOfferError) return c.json({ error: err.message }, 409);
      throw err;
    }

    log.info({ id: offer.id, requesterAddress, creatorAddress }, "Auto remix offer created");
    return c.json({ data: serializeOffer(offer, requesterAddress) }, 201);
  }
);

remixOffers.post(
  "/self/confirm",

  (c, next) => identityAuth(c, next),
  zValidator("json", selfConfirmSchema),
  async (c) => {
    const body = c.req.valid("json");
    const walletAddress = c.get("walletAddress") as string;

    const originalContract = normalizeAddress("STARKNET", body.originalContract);
    const originalTokenId = body.originalTokenId;

    const holderBalance = await prisma.tokenBalance.findFirst({
      where: { contractAddress: originalContract, tokenId: originalTokenId, owner: walletAddress, amount: { not: "0" } },
      select: { id: true },
    });
    if (!holderBalance) {

      const tokenExists = await prisma.token.findFirst({
        where: { contractAddress: originalContract, tokenId: originalTokenId },
        select: { id: true },
      });
      if (!tokenExists) return c.json({ error: "Token not found" }, 404);
      return c.json({ error: "You do not own this token" }, 403);
    }

    const remixContract = normalizeAddress("STARKNET", body.remixContract);
    const verified = await verifyTransactionSucceeded(body.txHash);
    if (verified.status !== "CONFIRMED") {
      return c.json({ error: `Mint transaction not verified on-chain: ${verified.failReason ?? "not found"}` }, 400);
    }
    const receiptEvents = await fetchReceiptEvents(body.txHash);
    const touchesRemixContract = receiptEvents.some((e) => e.from_address === remixContract);
    if (!touchesRemixContract) {
      return c.json({ error: "Transaction does not involve the claimed remix contract" }, 400);
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
        remixContract,
        remixTokenId: body.remixTokenId,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    log.info({ id: offer.id, walletAddress }, "Self-remix recorded");
    return c.json({ data: serializeOffer(offer, walletAddress) }, 201);
  }
);

remixOffers.post(
  "/:id/confirm",

  (c, next) => identityAuth(c, next),
  zValidator("json", confirmSchema),
  async (c) => {
    const { id } = c.req.param();
    const body = c.req.valid("json");
    const walletAddress = c.get("walletAddress") as string;

    const guard = await loadActionableOffer(id, walletAddress, "creatorAddress", "creator", "confirm");
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const updated = await prisma.remixOffer.update({
      where: { id },
      data: {
        status: "APPROVED",
        remixContract: normalizeAddress("STARKNET", body.remixContract),
        remixTokenId: body.remixTokenId,
        approvedCollection: normalizeAddress("STARKNET", body.approvedCollection),
        orderHash: body.orderHash,
      },
    });

    log.info({ id, remixContract: body.remixContract, orderHash: body.orderHash }, "Remix offer confirmed");
    return c.json({ data: serializeOffer(updated, walletAddress) });
  }
);

remixOffers.post(
  "/:id/reject",

  (c, next) => identityAuth(c, next),
  async (c) => {
    const { id } = c.req.param();
    const walletAddress = c.get("walletAddress") as string;

    const guard = await loadActionableOffer(id, walletAddress, "creatorAddress", "creator", "reject");
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const updated = await prisma.remixOffer.update({
      where: { id },
      data: { status: "REJECTED" },
    });

    log.info({ id, walletAddress }, "Remix offer rejected");
    return c.json({ data: serializeOffer(updated, walletAddress) });
  }
);

remixOffers.post(
  "/:id/extend",

  (c, next) => identityAuth(c, next),
  async (c) => {
    const { id } = c.req.param();
    const walletAddress = c.get("walletAddress") as string;

    if (!checkOfferRateLimit(walletAddress)) {
      return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }

    const body = await c.req.json().catch(() => null);
    const days = Number(body?.days);
    if (!days || days < 1 || days > 30) {
      return c.json({ error: "days must be between 1 and 30" }, 400);
    }

    const guard = await loadActionableOffer(id, walletAddress, "requesterAddress", "requester", "extend");
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);
    const { offer } = guard;

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

remixOffers.get(
  "/",

  (c, next) => identityAuth(c, next),
  zValidator("query", listSchema),
  async (c) => {
    const { role, status, page, limit } = c.req.valid("query");
    const walletAddress = c.get("walletAddress") as string;

    const where: PrismaTypes.RemixOfferWhereInput = {
      ...(role === "creator" ? { creatorAddress: walletAddress } : { requesterAddress: walletAddress }),
      ...(status ? { status: status as RemixOfferStatus } : {}),
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

remixOffers.get("/:id", async (c) => {
  const { id } = c.req.param();

  let callerWallet: string | undefined;
  try {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {

      await identityAuth(c, async () => {});
      callerWallet = c.get("walletAddress") as string | undefined;
    }
  } catch {  }

  const offer = await prisma.remixOffer.findUnique({ where: { id } });
  if (!offer) return c.json({ error: "Offer not found" }, 404);

  return c.json({ data: serializeOffer(offer, callerWallet) });
});

export default remixOffers;
