// POST /v1/intents/<type> — the eight intent creation endpoints. Each one:
//   1. Validates the body against its schema (from _shared.ts).
//   2. Calls into orchestrator/intent.ts to build typedData + calldata.
//   3. Persists a TransactionIntent row scoped to the caller's tenant.
//
// Lifecycle (GET/PATCH/POST on /:id) lives in lifecycle.ts; background
// verification + hydration lives in settle.ts.
import type { Hono } from "hono";
import { type Prisma as PrismaTypes } from "@prisma/client";
import prisma from "../../../db/client.js";
import {
  buildCreateListingIntent,
  buildMakeOfferIntent,
  buildFulfillOrderIntent,
  buildCancelOrderIntent,
  buildMintIntent,
  buildCreateCollectionIntent,
  buildCounterOfferIntent,
} from "../../../orchestrator/intent.js";
import { normalizeAddress } from "../../../utils/starknet.js";
import { toErrorMessage } from "../../../utils/error.js";
import type { AppEnv } from "../../../types/hono.js";
import {
  log,
  TTL_HOURS,
  listingSchema,
  offerSchema,
  fulfillSchema,
  cancelSchema,
  mintSchema,
  createCollectionSchema,
  counterOfferSchema,
  checkoutBodySchema,
} from "./_shared.js";

export function registerBuildRoutes(intents: Hono<AppEnv>): void {
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
          tenantId: c.get("tenant")?.id ?? null,
          typedData: typedData as unknown as PrismaTypes.InputJsonValue,
          calls: calls as PrismaTypes.InputJsonValue,
          expiresAt,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: true, typedData, calls, expiresAt } }, 201);
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

    if (!parsed.data.tokenStandard) {
      log.warn({ nftContract: parsed.data.nftContract, offerer: parsed.data.offerer }, "tokenStandard omitted in offer intent — routing determined by DB lookup");
    }

    try {
      const { typedData, calls } = await buildMakeOfferIntent(parsed.data);
      const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

      const intent = await prisma.transactionIntent.create({
        data: {
          type: "MAKE_OFFER",
          requester: normalizeAddress(parsed.data.offerer),
          tenantId: c.get("tenant")?.id ?? null,
          typedData: typedData as unknown as PrismaTypes.InputJsonValue,
          calls: calls as PrismaTypes.InputJsonValue,
          expiresAt,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: true, typedData, calls, expiresAt } }, 201);
    } catch (err: unknown) {
      log.error({ err }, "Failed to build offer intent");
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // POST /v1/intents/counter-offer
  intents.post("/counter-offer", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = counterOfferSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
    }

    const { sellerAddress, originalOrderHash, durationSeconds, priceRaw, message } = parsed.data;
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

    // Counter-offer only supported for ERC-721 orders — ERC-1155 uses a different contract and domain.
    if (originalOrder.considerationItemType === "ERC1155") {
      return c.json({ error: "Counter-offer is not supported for ERC-1155 orders" }, 400);
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
        priceRaw,
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
            tenantId: c.get("tenant")?.id ?? null,
            typedData: typedData as unknown as PrismaTypes.InputJsonValue,
            calls: calls as PrismaTypes.InputJsonValue,
            expiresAt,
            parentOrderHash: originalOrderHash,
            counterOfferMessage: message ?? null,
          },
        });

        // The parent bid stays `status: ACTIVE`. Its "has been countered"
        // affordance is computed at read time via `hasActiveCounterOffer`
        // (serialize.ts:counterOfferFlags). Counter-offers are linked orders,
        // not a third lifecycle state on the parent — 01-core-model §V.
        // Removed the legacy `tx.order.update({ status: "COUNTER_OFFERED" })`
        // write on 2026-05-25 (audit P0-1 Phase B).

        return created;
      });

      return c.json({ data: { id: intent.id, requiresSignature: true, typedData, calls, expiresAt } }, 201);
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
      if (!parsed.data.tokenStandard) {
        const order = await prisma.order.findFirst({
          where: { chain: "STARKNET", orderHash: parsed.data.orderHash },
          select: { id: true },
        });
        if (!order) {
          return c.json({ error: "Order not found in index — provide tokenStandard hint" }, 400);
        }
      }

      const { calls } = await buildFulfillOrderIntent(parsed.data);
      const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

      // Unsigned fulfilment — calls are fully populated; create SIGNED (like mint).
      const intent = await prisma.transactionIntent.create({
        data: {
          type: "FULFILL_ORDER",
          requester: normalizeAddress(parsed.data.fulfiller),
          tenantId: c.get("tenant")?.id ?? null,
          typedData: {},
          calls: calls as PrismaTypes.InputJsonValue,
          status: "SIGNED",
          orderHash: parsed.data.orderHash,
          expiresAt,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: false, calls, expiresAt } }, 201);
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

    if (!parsed.data.tokenStandard) {
      const order = await prisma.order.findFirst({
        where: { chain: "STARKNET", orderHash: parsed.data.orderHash },
        select: { id: true },
      });
      if (!order) {
        return c.json({ error: "Order not found in index — provide tokenStandard hint" }, 400);
      }
    }

    try {
      const { typedData, calls } = await buildCancelOrderIntent(parsed.data);
      const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

      const intent = await prisma.transactionIntent.create({
        data: {
          type: "CANCEL_ORDER",
          requester: normalizeAddress(parsed.data.offerer),
          tenantId: c.get("tenant")?.id ?? null,
          typedData: typedData as unknown as PrismaTypes.InputJsonValue,
          calls: calls as PrismaTypes.InputJsonValue,
          orderHash: parsed.data.orderHash,
          expiresAt,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: true, typedData, calls, expiresAt } }, 201);
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
          tenantId: c.get("tenant")?.id ?? null,
          typedData: {},
          calls: calls as PrismaTypes.InputJsonValue,
          status: "SIGNED",
          expiresAt,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: false, calls, expiresAt } }, 201);
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
          tenantId: c.get("tenant")?.id ?? null,
          typedData: {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            image: parsed.data.image ?? null,
            owner: normalizeAddress(parsed.data.owner),
          },
          calls: calls as PrismaTypes.InputJsonValue,
          status: "SIGNED",
          expiresAt,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: false, calls, expiresAt } }, 201);
    } catch (err: unknown) {
      log.error({ err }, "Failed to build create-collection intent");
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // POST /v1/intents/checkout — batch fulfill order intents
  intents.post("/checkout", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = checkoutBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const { fulfiller, orderHashes } = parsed.data;
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    const normalizedFulfiller = normalizeAddress(fulfiller);
    const tenantId = c.get("tenant")?.id ?? null;

    // 1) Batch existence check — one query instead of N findFirst calls. Guard:
    //    if the order isn't indexed yet we cannot safely determine ERC721 vs
    //    ERC1155 routing and would silently submit ERC1155 orders to the
    //    ERC721 contract.
    const indexed = await prisma.order.findMany({
      where: { chain: "STARKNET", orderHash: { in: orderHashes } },
      select: { orderHash: true },
    });
    const indexedSet = new Set(indexed.map((o) => o.orderHash));

    // 2) Build typed data + calls in parallel. Build failures land in `results`
    //    as per-order errors without aborting the batch.
    type Built =
      | { ok: true; orderHash: string; calls: unknown }
      | { ok: false; orderHash: string; error: string };

    const builds: Built[] = await Promise.all(
      orderHashes.map(async (orderHash): Promise<Built> => {
        if (!indexedSet.has(orderHash)) {
          return {
            ok: false,
            orderHash,
            error: "Order not found in index — cannot determine token standard for checkout",
          };
        }
        try {
          const { calls } = await buildFulfillOrderIntent({
            fulfiller: normalizedFulfiller,
            orderHash,
          });
          return { ok: true, orderHash, calls };
        } catch (err) {
          return {
            ok: false,
            orderHash,
            error: err instanceof Error ? err.message : "Failed to create intent",
          };
        }
      })
    );

    // 3) Bulk-insert successful builds in one round trip via createManyAndReturn
    //    (Prisma 5.14+), preserving generated ids so we can echo them back.
    const successful = builds.filter((b): b is Extract<Built, { ok: true }> => b.ok);
    const insertedIntents = successful.length
      ? await prisma.transactionIntent.createManyAndReturn({
          data: successful.map((b) => ({
            type: "FULFILL_ORDER" as const,
            requester: normalizedFulfiller,
            tenantId,
            typedData: {},
            calls: b.calls as PrismaTypes.InputJsonValue,
            status: "SIGNED" as const,
            orderHash: b.orderHash,
            expiresAt,
          })),
          select: { id: true, orderHash: true },
        })
      : [];

    // 4) Assemble response in input order. createManyAndReturn preserves the
    //    input order on Postgres but we look up by orderHash anyway to be
    //    defensive.
    const idByHash = new Map(insertedIntents.map((row) => [row.orderHash, row.id]));
    const builtByHash = new Map(successful.map((b) => [b.orderHash, b]));
    const results = builds.map((b) => {
      if (!b.ok) return { orderHash: b.orderHash, error: b.error };
      const built = builtByHash.get(b.orderHash);
      return {
        id: idByHash.get(b.orderHash),
        orderHash: b.orderHash,
        requiresSignature: false as const,
        calls: built?.calls,
        expiresAt: expiresAt.toISOString(),
      };
    });

    return c.json({ data: results }, 201);
  });
}
