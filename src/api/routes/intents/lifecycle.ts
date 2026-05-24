// Lifecycle routes — read + transition an existing intent's state.
//   GET    /v1/intents/:id            — read (auto-expires PENDING past TTL on read)
//   PATCH  /v1/intents/:id/signature  — submit signature, populate calldata (ChipiPay flow)
//   POST   /v1/intents/:id/hydrate    — tenant-safe repair for confirmed marketplace txs
//   PATCH  /v1/intents/:id/confirm    — submit tx hash; verifyAndSettle runs fire-and-forget
//
// Creation routes (POST /v1/intents/<type>) live in build.ts; settlement
// + hydration helpers live in settle.ts.
import type { Hono } from "hono";
import { type Prisma as PrismaTypes } from "@prisma/client";
import prisma from "../../../db/client.js";
import { buildPopulatedCalls } from "../../../orchestrator/submit.js";
import type { AppEnv } from "../../../types/hono.js";
import {
  log,
  confirmSchema,
  MARKETPLACE_INTENT_TYPES,
  RECEIPT_HYDRATED_INTENT_TYPES,
  ORDER_CREATING_INTENT_TYPES,
} from "./_shared.js";
import {
  verifyAndSettle,
  hydrateCreatedOrdersFromTx,
  hydrateFulfillmentFromTx,
} from "./settle.js";

export function registerLifecycleRoutes(intents: Hono<AppEnv>): void {
  // GET /v1/intents/:id
  intents.get("/:id", async (c) => {
    const { id } = c.req.param();
    const intent = await prisma.transactionIntent.findUnique({ where: { id } });
    if (!intent) return c.json({ error: "Intent not found" }, 404);

    // Tenant isolation: only the tenant that created the intent can read it
    const callerTenantId = c.get("tenant")?.id;
    if (intent.tenantId && callerTenantId && intent.tenantId !== callerTenantId) {
      return c.json({ error: "Intent not found" }, 404);
    }

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

    // Ownership check — tenantId is set on all new intents; null means a pre-migration intent
    const callerTenantId = c.get("tenant")?.id;
    if (intent.tenantId && callerTenantId && intent.tenantId !== callerTenantId) {
      return c.json({ error: "Intent not found" }, 404);
    }

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
      data: { signature: body.signature, status: "SIGNED", calls: populatedCalls as PrismaTypes.InputJsonValue },
    });

    log.info({ id, type: intent.type }, "Intent signed — calls populated, ready for client submission");
    return c.json({ data: updated });
  });

  // POST /v1/intents/:id/hydrate — tenant-safe repair for confirmed marketplace txs
  intents.post("/:id/hydrate", async (c) => {
    const { id } = c.req.param();
    const intent = await prisma.transactionIntent.findUnique({ where: { id } });
    if (!intent) return c.json({ error: "Intent not found" }, 404);

    const callerTenantId = c.get("tenant")?.id;
    if (intent.tenantId && callerTenantId && intent.tenantId !== callerTenantId) {
      return c.json({ error: "Intent not found" }, 404);
    }

    if (!intent.txHash) {
      return c.json({ error: "Intent has no transaction hash" }, 409);
    }
    if (!ORDER_CREATING_INTENT_TYPES.has(intent.type) && intent.type !== "FULFILL_ORDER") {
      return c.json({ error: "Intent type cannot be hydrated" }, 400);
    }
    if (intent.status !== "CONFIRMED" && intent.status !== "SUBMITTED") {
      return c.json({ error: `Intent is ${intent.status}` }, 409);
    }

    if (intent.type === "FULFILL_ORDER") {
      await hydrateFulfillmentFromTx(intent.txHash);
      await prisma.transactionIntent.update({
        where: { id },
        data: { status: "CONFIRMED" },
      });
      return c.json({ data: { id, txHash: intent.txHash, orderHashes: intent.orderHash ? [intent.orderHash] : [] } });
    }

    const orderHashes = await hydrateCreatedOrdersFromTx(intent.txHash);
    if (orderHashes[0]) {
      await prisma.transactionIntent.update({
        where: { id },
        data: { orderHash: orderHashes[0], status: "CONFIRMED" },
      });
    }
    return c.json({ data: { id, txHash: intent.txHash, orderHashes } });
  });

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

    // Ownership check — tenantId is set on all new intents; null means a pre-migration intent
    const callerTenantId = c.get("tenant")?.id;
    if (intent.tenantId && callerTenantId && intent.tenantId !== callerTenantId) {
      return c.json({ error: "Intent not found" }, 404);
    }

    if (!MARKETPLACE_INTENT_TYPES.has(intent.type) && !RECEIPT_HYDRATED_INTENT_TYPES.has(intent.type)) {
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
}
