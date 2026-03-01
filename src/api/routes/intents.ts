import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import {
  buildCreateListingIntent,
  buildMakeOfferIntent,
  buildFulfillOrderIntent,
  buildCancelOrderIntent,
} from "../../orchestrator/intent.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { buildPopulatedCalls } from "../../orchestrator/submit.js";

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

export default intents;
