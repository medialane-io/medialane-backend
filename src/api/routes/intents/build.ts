// POST /v1/intents/<type> — the intent creation endpoints. Each one:
//   1. Validates the body against its schema (from _shared.ts).
//   2. Calls into orchestrator/intent.ts to build typedData + calldata.
//   3. Persists a TransactionIntent row scoped to the caller's Account.
//
// Most routes are this shape exactly, differing only in schema/builder/type/
// which field holds the requester address/whether SNIP-12 signing is needed
// — those are registered via registerIntentRoute() below. A few routes carry
// real extra logic (DB validation, custom typedData, batching) and stay
// hand-written: offer, counter-offer, create-collection, checkout.
//
// Lifecycle (GET/PATCH/POST on /:id) lives in lifecycle.ts; background
// verification + hydration lives in settle.ts.
import type { Hono } from "hono";
import type { Context } from "hono";
import { type Prisma as PrismaTypes, type IntentType } from "@prisma/client";
import type { ZodType } from "zod";
import prisma from "../../../db/client.js";
import {
  buildCreateListingIntent,
  buildMakeOfferIntent,
  buildFulfillOrderIntent,
  buildCancelOrderIntent,
  buildMintIntent,
  buildCreateCollectionIntent,
  buildCreateTierIntent,
  buildCreateCoinIntent,
  buildLaunchCoinIntent,
  buildCounterOfferIntent,
  buildCreateSponsorshipOfferIntent,
  buildSetSponsorshipOfferOpenIntent,
  buildPlaceSponsorshipBidIntent,
  buildRetractSponsorshipBidIntent,
  buildAcceptSponsorshipBidIntent,
  buildCreateSponsorshipProposalIntent,
  buildWithdrawSponsorshipProposalIntent,
  buildAcceptSponsorshipProposalIntent,
  buildRejectSponsorshipProposalIntent,
} from "../../../orchestrator/intent/index.js";
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
  createTierSchema,
  createCoinSchema,
  launchCoinSchema,
  counterOfferSchema,
  checkoutBodySchema,
  sponsorshipOfferSchema,
  sponsorshipOfferOpenSchema,
  sponsorshipBidSchema,
  sponsorshipBidRetractSchema,
  sponsorshipBidAcceptSchema,
  sponsorshipProposalSchema,
  sponsorshipProposalWithdrawSchema,
  sponsorshipProposalAcceptSchema,
  sponsorshipProposalRejectSchema,
} from "./_shared.js";

function expiresAt(): Date {
  return new Date(Date.now() + TTL_HOURS * 3600 * 1000);
}

interface IntentRouteConfig<T> {
  path: string;
  schema: ZodType<T, any, any>;
  type: IntentType;
  /** Body field holding the address that becomes TransactionIntent.requester. */
  requesterField: keyof T & string;
  build: (body: T) => Promise<{ typedData?: unknown; calls: unknown }>;
  /** true: PENDING row, real typedData, client must sign (SNIP-12).
   *  false: SIGNED row, typedData {}, calls are already fully populated. */
  requiresSignature: boolean;
  /** Body field holding an existing order's hash — stored on the row, and
   *  guarded: if the caller omitted tokenStandard, the order must already be
   *  indexed (otherwise we can't tell ERC-721 from ERC-1155 routing). */
  orderHashField?: keyof T & string;
}

/** Registers the common "validate → build → persist → respond" shape shared
 *  by most /v1/intents/* routes. See the file header for what stays hand-written. */
function registerIntentRoute<T>(
  intents: Hono<AppEnv>,
  cfg: IntentRouteConfig<T>
): void {
  intents.post(cfg.path, async (c: Context<AppEnv>) => {
    const body = await c.req.json().catch(() => null);
    const parsed = cfg.schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
    }

    const tokenStandard = (parsed.data as Record<string, unknown>).tokenStandard;
    if (cfg.orderHashField && !tokenStandard) {
      const orderHash = parsed.data[cfg.orderHashField] as unknown as string;
      const order = await prisma.order.findFirst({
        where: { chain: "STARKNET", orderHash },
        select: { id: true },
      });
      if (!order) {
        return c.json({ error: "Order not found in index — provide tokenStandard hint" }, 400);
      }
    }

    try {
      const built = await cfg.build(parsed.data);
      const requester = normalizeAddress("STARKNET", parsed.data[cfg.requesterField] as unknown as string);
      const ttl = expiresAt();

      const intent = await prisma.transactionIntent.create({
        data: {
          type: cfg.type,
          requester,
          accountId: c.get("account").id,
          typedData: (cfg.requiresSignature ? built.typedData : {}) as unknown as PrismaTypes.InputJsonValue,
          calls: built.calls as PrismaTypes.InputJsonValue,
          ...(cfg.requiresSignature ? {} : { status: "SIGNED" as const }),
          ...(cfg.orderHashField ? { orderHash: parsed.data[cfg.orderHashField] as unknown as string } : {}),
          expiresAt: ttl,
        },
      });

      return c.json(
        {
          data: cfg.requiresSignature
            ? { id: intent.id, requiresSignature: true, typedData: built.typedData, calls: built.calls, expiresAt: ttl }
            : { id: intent.id, requiresSignature: false, calls: built.calls, expiresAt: ttl },
        },
        201
      );
    } catch (err: unknown) {
      log.error({ err }, `Failed to build ${cfg.path.slice(1)} intent`);
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });
}

export function registerBuildRoutes(intents: Hono<AppEnv>): void {
  registerIntentRoute(intents, {
    path: "/listing",
    schema: listingSchema,
    type: "CREATE_LISTING",
    requesterField: "offerer",
    build: buildCreateListingIntent,
    requiresSignature: true,
  });

  registerIntentRoute(intents, {
    path: "/cancel",
    schema: cancelSchema,
    type: "CANCEL_ORDER",
    requesterField: "offerer",
    build: buildCancelOrderIntent,
    requiresSignature: true,
    orderHashField: "orderHash",
  });

  registerIntentRoute(intents, {
    path: "/fulfill",
    schema: fulfillSchema,
    type: "FULFILL_ORDER",
    requesterField: "fulfiller",
    build: buildFulfillOrderIntent,
    requiresSignature: false,
    orderHashField: "orderHash",
  });

  registerIntentRoute(intents, {
    path: "/mint",
    schema: mintSchema,
    type: "MINT",
    requesterField: "owner",
    build: buildMintIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/create-tier",
    schema: createTierSchema,
    type: "CREATE_TIER",
    requesterField: "owner",
    build: buildCreateTierIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/create-coin",
    schema: createCoinSchema,
    type: "CREATE_COIN",
    requesterField: "owner",
    build: buildCreateCoinIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/launch-coin",
    schema: launchCoinSchema,
    type: "LAUNCH_COIN",
    requesterField: "owner",
    build: buildLaunchCoinIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-offer",
    schema: sponsorshipOfferSchema,
    type: "CREATE_SPONSORSHIP_OFFER",
    requesterField: "author",
    build: buildCreateSponsorshipOfferIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-offer-open",
    schema: sponsorshipOfferOpenSchema,
    type: "SET_SPONSORSHIP_OFFER_OPEN",
    requesterField: "author",
    build: buildSetSponsorshipOfferOpenIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-bid",
    schema: sponsorshipBidSchema,
    type: "PLACE_SPONSORSHIP_BID",
    requesterField: "sponsor",
    build: buildPlaceSponsorshipBidIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-bid-retract",
    schema: sponsorshipBidRetractSchema,
    type: "RETRACT_SPONSORSHIP_BID",
    requesterField: "sponsor",
    build: buildRetractSponsorshipBidIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-bid-accept",
    schema: sponsorshipBidAcceptSchema,
    type: "ACCEPT_SPONSORSHIP_BID",
    requesterField: "author",
    build: buildAcceptSponsorshipBidIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-proposal",
    schema: sponsorshipProposalSchema,
    type: "CREATE_SPONSORSHIP_PROPOSAL",
    requesterField: "proposer",
    build: buildCreateSponsorshipProposalIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-proposal-withdraw",
    schema: sponsorshipProposalWithdrawSchema,
    type: "WITHDRAW_SPONSORSHIP_PROPOSAL",
    requesterField: "proposer",
    build: buildWithdrawSponsorshipProposalIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-proposal-accept",
    schema: sponsorshipProposalAcceptSchema,
    type: "ACCEPT_SPONSORSHIP_PROPOSAL",
    requesterField: "owner",
    build: buildAcceptSponsorshipProposalIntent,
    requiresSignature: false,
  });

  registerIntentRoute(intents, {
    path: "/sponsorship-proposal-reject",
    schema: sponsorshipProposalRejectSchema,
    type: "REJECT_SPONSORSHIP_PROPOSAL",
    requesterField: "owner",
    build: buildRejectSponsorshipProposalIntent,
    requiresSignature: false,
  });

  // POST /v1/intents/offer — kept hand-written: the tokenStandard-omitted
  // case is a warn-and-continue (routing determined later by DB lookup),
  // not a guard, so it doesn't fit registerIntentRoute's hard-guard shape.
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
      const ttl = expiresAt();

      const intent = await prisma.transactionIntent.create({
        data: {
          type: "MAKE_OFFER",
          requester: normalizeAddress("STARKNET", parsed.data.offerer),
          accountId: c.get("account").id,
          typedData: typedData as unknown as PrismaTypes.InputJsonValue,
          calls: calls as PrismaTypes.InputJsonValue,
          expiresAt: ttl,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: true, typedData, calls, expiresAt: ttl } }, 201);
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
    const normalizedSeller = normalizeAddress("STARKNET", sellerAddress);

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
    if (normalizedSeller !== normalizeAddress("STARKNET", originalOrder.considerationRecipient)) {
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

      const ttl = expiresAt();

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
            accountId: c.get("account").id,
            typedData: typedData as unknown as PrismaTypes.InputJsonValue,
            calls: calls as PrismaTypes.InputJsonValue,
            expiresAt: ttl,
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

      return c.json({ data: { id: intent.id, requiresSignature: true, typedData, calls, expiresAt: ttl } }, 201);
    } catch (err: unknown) {
      if ((err as any)?.code === "COUNTER_ALREADY_EXISTS") {
        return c.json({ error: "A counter-offer already exists for this order" }, 400);
      }
      log.error({ err }, "Failed to build counter-offer intent");
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // POST /v1/intents/create-collection — kept hand-written: typedData stores
  // name/description/image (not the builder's typedData) so
  // COLLECTION_METADATA_FETCH can recover them.
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
      const ttl = expiresAt();

      const intent = await prisma.transactionIntent.create({
        data: {
          type: "CREATE_COLLECTION",
          requester: normalizeAddress("STARKNET", parsed.data.owner),
          accountId: c.get("account").id,
          typedData: {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            image: parsed.data.image ?? null,
            owner: normalizeAddress("STARKNET", parsed.data.owner),
          },
          calls: calls as PrismaTypes.InputJsonValue,
          status: "SIGNED",
          expiresAt: ttl,
        },
      });

      return c.json({ data: { id: intent.id, requiresSignature: false, calls, expiresAt: ttl } }, 201);
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
    const ttl = expiresAt();
    const normalizedFulfiller = normalizeAddress("STARKNET", fulfiller);
    const accountId = c.get("account").id;

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
            accountId,
            typedData: {},
            calls: b.calls as PrismaTypes.InputJsonValue,
            status: "SIGNED" as const,
            orderHash: b.orderHash,
            expiresAt: ttl,
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
        expiresAt: ttl.toISOString(),
      };
    });

    return c.json({ data: results }, 201);
  });
}
