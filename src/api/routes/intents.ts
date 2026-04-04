import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import {
  buildCreateListingIntent,
  buildMakeOfferIntent,
  buildFulfillOrderIntent,
  buildCancelOrderIntent,
  buildMintIntent,
  buildCreateCollectionIntent,
  buildCounterOfferIntent,
} from "../../orchestrator/intent.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { buildPopulatedCalls } from "../../orchestrator/submit.js";
import { verifyMarketplaceTx } from "../../utils/txVerifier.js";

const log = createLogger("routes:intents");
const intents = new Hono();

const listingSchema = z.object({
  offerer: z.string(),
  nftContract: z.string(),
  tokenId: z.string(),
  currency: z.string(),
  price: z.string(),
  endTime: z.number(),
  salt: z.string().optional(),
});

const offerSchema = listingSchema;

const fulfillSchema = z.object({
  fulfiller: z.string(),
  orderHash: z.string(),
});

const cancelSchema = z.object({
  offerer: z.string(),
  orderHash: z.string(),
});

const mintSchema = z.object({
  owner: z.string(),
  collectionId: z.string().regex(/^\d+$/, "collectionId must be a non-negative integer string"),
  recipient: z.string(),
  tokenUri: z.string().min(1),
  collectionContract: z.string().optional(),
});

const createCollectionSchema = z.object({
  owner: z.string(),
  name: z.string().min(1),
  symbol: z.string().min(1),
  baseUri: z.string().default(""),
  description: z.string().optional(),
  image: z.string().optional(),
  collectionContract: z.string().optional(),
});

const TTL_HOURS = 24;

// POST /v1/intents/listing
intents.post("/listing", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = listingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const { typedData, calls } = await buildCreateListingIntent(parsed.data);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    const intent = await prisma.transactionIntent.create({
      data: {
        type: "CREATE_LISTING",
        requester: normalizeAddress(parsed.data.offerer),
        typedData: typedData as any,
        calls: calls as any,
        expiresAt,
      },
    });

    return c.json({ data: { id: intent.id, typedData, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to build listing intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/intents/offer
intents.post("/offer", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = offerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const { typedData, calls } = await buildMakeOfferIntent(parsed.data);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    const intent = await prisma.transactionIntent.create({
      data: {
        type: "MAKE_OFFER",
        requester: normalizeAddress(parsed.data.offerer),
        typedData: typedData as any,
        calls: calls as any,
        expiresAt,
      },
    });

    return c.json({ data: { id: intent.id, typedData, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to build offer intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

const counterOfferSchema = z.object({
  sellerAddress:     z.string().min(1),
  originalOrderHash: z.string().min(1),
  durationSeconds:   z.number().int().min(3600).max(2592000),
  counterPrice:      z.string().regex(/^\d+$/, "counterPrice must be a non-negative integer string"),
  message:           z.string().max(500).optional(),
});

// POST /v1/intents/counter-offer
intents.post("/counter-offer", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = counterOfferSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { sellerAddress, originalOrderHash, durationSeconds, counterPrice, message } = parsed.data;
  const normalizedSeller = normalizeAddress(sellerAddress);

  // 1. Validate original order: must be active + a bid (ERC20 offer)
  const originalOrder = await prisma.order.findFirst({
    where: {
      chain: "STARKNET",
      orderHash: originalOrderHash,
      status: "ACTIVE",
      offerItemType: "ERC20",
    },
  });
  if (!originalOrder) {
    return c.json({ error: "Original order not found or not active" }, 400);
  }

  // 2. Validate seller owns the NFT (considerationRecipient on a bid = NFT owner)
  if (normalizedSeller !== normalizeAddress(originalOrder.considerationRecipient)) {
    return c.json({ error: "sellerAddress does not match order recipient" }, 400);
  }

  try {
    // Currency is derived server-side from the original bid — never trusted from client
    const { typedData, calls } = await buildCounterOfferIntent({
      sellerAddress:   normalizedSeller,
      nftContract:     originalOrder.considerationToken,
      tokenId:         originalOrder.considerationIdentifier,
      currencyAddress: originalOrder.offerToken,
      priceRaw:        counterPrice,
      durationSeconds,
    });

    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    // Atomic: re-check for existing counter INSIDE the transaction to close the TOCTOU
    // window. Two concurrent requests both passing the outer check could previously
    // both succeed and create duplicate counter-offer intents for the same bid.
    const intent = await prisma.$transaction(async (tx) => {
      const existingCounter = await tx.order.findFirst({
        where: { chain: "STARKNET", parentOrderHash: originalOrderHash, status: "ACTIVE" },
      });
      if (existingCounter) {
        throw Object.assign(new Error("A counter-offer already exists for this order"), {
          code: "COUNTER_ALREADY_EXISTS",
        });
      }

      const created = await tx.transactionIntent.create({
        data: {
          type: "COUNTER_OFFER",
          requester: normalizedSeller,
          typedData: typedData as any,
          calls: calls as any,
          expiresAt,
          parentOrderHash: originalOrderHash,
          counterOfferMessage: message ?? null,
        },
      });

      await tx.order.update({
        where: { chain_orderHash: { chain: "STARKNET", orderHash: originalOrderHash } },
        data: { status: "COUNTER_OFFERED" },
      });

      return created;
    });

    return c.json({ data: { id: intent.id, typedData, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    if ((err as any)?.code === "COUNTER_ALREADY_EXISTS") {
      return c.json({ error: "A counter-offer already exists for this order" }, 400);
    }
    log.error({ err }, "Failed to build counter-offer intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/intents/fulfill
intents.post("/fulfill", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = fulfillSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const { typedData, calls } = await buildFulfillOrderIntent(parsed.data);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    const intent = await prisma.transactionIntent.create({
      data: {
        type: "FULFILL_ORDER",
        requester: normalizeAddress(parsed.data.fulfiller),
        typedData: typedData as any,
        calls: calls as any,
        orderHash: parsed.data.orderHash,
        expiresAt,
      },
    });

    return c.json({ data: { id: intent.id, typedData, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to build fulfill intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/intents/cancel
intents.post("/cancel", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const { typedData, calls } = await buildCancelOrderIntent(parsed.data);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    const intent = await prisma.transactionIntent.create({
      data: {
        type: "CANCEL_ORDER",
        requester: normalizeAddress(parsed.data.offerer),
        typedData: typedData as any,
        calls: calls as any,
        orderHash: parsed.data.orderHash,
        expiresAt,
      },
    });

    return c.json({ data: { id: intent.id, typedData, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to build cancel intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/intents/mint
intents.post("/mint", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const { calls } = await buildMintIntent(parsed.data);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    // No SNIP-12 signature needed — calls are fully populated at creation.
    const intent = await prisma.transactionIntent.create({
      data: {
        type: "MINT",
        requester: normalizeAddress(parsed.data.owner),
        typedData: {},
        calls: calls as any,
        status: "SIGNED",
        expiresAt,
      },
    });

    return c.json({ data: { id: intent.id, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to build mint intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/intents/create-collection
intents.post("/create-collection", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createCollectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  try {
    const { calls } = await buildCreateCollectionIntent({
      ...parsed.data,
      description: parsed.data.description,
      image: parsed.data.image,
    });
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

    // No SNIP-12 signature needed — calls are fully populated at creation.
    // Store name + description in typedData so COLLECTION_METADATA_FETCH can recover them.
    const intent = await prisma.transactionIntent.create({
      data: {
        type: "CREATE_COLLECTION",
        requester: normalizeAddress(parsed.data.owner),
        typedData: {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          image: parsed.data.image ?? null,
          owner: normalizeAddress(parsed.data.owner),
        },
        calls: calls as any,
        status: "SIGNED",
        expiresAt,
      },
    });

    return c.json({ data: { id: intent.id, calls, expiresAt } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to build create-collection intent");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/intents/checkout — batch fulfill order intents
const checkoutBodySchema = z.object({
  fulfiller: z.string().min(1),
  orderHashes: z.array(z.string().min(1)).min(1).max(20),
});

intents.post("/checkout", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = checkoutBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }

  const { fulfiller, orderHashes } = parsed.data;
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
  const results = [];

  for (const orderHash of orderHashes) {
    try {
      const { typedData, calls } = await buildFulfillOrderIntent({
        fulfiller: normalizeAddress(fulfiller),
        orderHash,
      });

      const intent = await prisma.transactionIntent.create({
        data: {
          type: "FULFILL_ORDER",
          requester: normalizeAddress(fulfiller),
          typedData: typedData as any,
          calls: calls as any,
          orderHash,
          expiresAt,
        },
      });

      results.push({
        id: intent.id,
        orderHash,
        typedData,
        calls,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      results.push({
        orderHash,
        error: err instanceof Error ? err.message : "Failed to create intent",
      });
    }
  }

  return c.json({ data: results }, 201);
});

// GET /v1/intents/:id
intents.get("/:id", async (c) => {
  const { id } = c.req.param();
  const intent = await prisma.transactionIntent.findUnique({ where: { id } });
  if (!intent) return c.json({ error: "Intent not found" }, 404);

  // Check expiry — updateMany with conditional to avoid race between concurrent requests
  if (intent.expiresAt < new Date() && intent.status === "PENDING") {
    const { count } = await prisma.transactionIntent.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    if (count > 0) intent.status = "EXPIRED";
  }

  return c.json({ data: intent });
});

// PATCH /v1/intents/:id/signature — Submit signature (ChipiPay flow)
intents.patch("/:id/signature", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);

  if (!body?.signature || !Array.isArray(body.signature)) {
    return c.json({ error: "signature array required" }, 400);
  }

  const intent = await prisma.transactionIntent.findUnique({ where: { id } });
  if (!intent) return c.json({ error: "Intent not found" }, 404);
  if (intent.type === "MINT" || intent.type === "CREATE_COLLECTION") {
    return c.json({ error: "Intent type does not require a signature" }, 400);
  }
  if (intent.status !== "PENDING") {
    return c.json({ error: `Intent is ${intent.status}` }, 409);
  }

  // Populate calldata for the marketplace calls using the stored message + signature
  const populatedCalls = buildPopulatedCalls(
    intent.type,
    (intent.typedData as Record<string, unknown> & { message: Record<string, unknown> }).message,
    intent.calls as { contractAddress: string; entrypoint: string; calldata: string[] }[],
    body.signature
  );

  const updated = await prisma.transactionIntent.update({
    where: { id },
    data: { signature: body.signature, status: "SIGNED", calls: populatedCalls as any },
  });

  log.info({ id, type: intent.type }, "Intent signed — calls populated, ready for client submission");
  return c.json({ data: updated });
});

const confirmSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid transaction hash"),
});

// Intent types that go through the marketplace contract and need event verification
const MARKETPLACE_INTENT_TYPES = new Set([
  "CREATE_LISTING",
  "MAKE_OFFER",
  "FULFILL_ORDER",
  "CANCEL_ORDER",
  "COUNTER_OFFER",
]);

/** Background: verify tx receipt and settle intent to CONFIRMED or FAILED.
 *  For FULFILL_ORDER intents, also marks the order FULFILLED so the API
 *  reflects the correct state before the indexer catches up (~6s delay). */
async function verifyAndSettle(intentId: string, txHash: string): Promise<void> {
  const [intent, verifyResult] = await Promise.all([
    prisma.transactionIntent.findUnique({
      where: { id: intentId },
      select: { type: true, orderHash: true },
    }),
    verifyMarketplaceTx(txHash),
  ]);

  if (verifyResult.status === "CONFIRMED") {
    if (intent?.type === "FULFILL_ORDER" && intent.orderHash) {
      // Atomic: confirm intent + mark order FULFILLED so the UI updates immediately
      await prisma.$transaction([
        prisma.transactionIntent.update({
          where: { id: intentId },
          data: { status: "CONFIRMED" },
        }),
        prisma.order.update({
          where: { chain_orderHash: { chain: "STARKNET", orderHash: intent.orderHash } },
          data: { status: "FULFILLED" },
        }),
      ]);
    } else {
      await prisma.transactionIntent.update({
        where: { id: intentId },
        data: { status: "CONFIRMED" },
      });
    }
    log.info({ intentId, txHash, type: intent?.type }, "Intent CONFIRMED");
  } else {
    await prisma.transactionIntent.update({
      where: { id: intentId },
      data: { status: "FAILED" },
    });
    log.warn({ intentId, txHash, reason: verifyResult.failReason }, "Intent FAILED");
  }
}

// PATCH /v1/intents/:id/confirm — submit tx hash; background verification settles status
intents.patch("/:id/confirm", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);

  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { txHash } = parsed.data;
  const intent = await prisma.transactionIntent.findUnique({ where: { id } });
  if (!intent) return c.json({ error: "Intent not found" }, 404);

  if (!MARKETPLACE_INTENT_TYPES.has(intent.type)) {
    return c.json({ error: "Intent type does not require tx confirmation" }, 400);
  }

  // Idempotent — already processing or settled
  if (intent.status === "SUBMITTED" || intent.status === "CONFIRMED" || intent.status === "FAILED") {
    return c.json({ data: intent });
  }

  if (intent.status !== "SIGNED") {
    return c.json({ error: `Intent is ${intent.status}` }, 409);
  }

  const updated = await prisma.transactionIntent.update({
    where: { id },
    data: { status: "SUBMITTED", txHash },
  });

  // Fire-and-forget — client polls GET /:id for the terminal status
  verifyAndSettle(id, txHash).catch((err) => {
    log.error({ err, id, txHash }, "verifyAndSettle threw unexpectedly");
  });

  log.info({ id, txHash }, "Intent submitted for background verification");
  return c.json({ data: updated }, 202);
});

export default intents;
