

import type { Hono } from "hono";
import { type Prisma as PrismaTypes } from "@prisma/client";
import prisma from "../../../db/client.js";
import { buildPopulatedCalls } from "../../../orchestrator/submit.js";
import { verifyWalletSignature, type VerifyResult } from "../../../auth/verify.js";
import type { AppEnv } from "../../../types/hono.js";
import {
  log,
  confirmSchema,
  signatureSchema,
  MARKETPLACE_INTENT_TYPES,
  RECEIPT_HYDRATED_INTENT_TYPES,
  ORDER_CREATING_INTENT_TYPES,
} from "./_shared.js";
import {
  verifyAndSettle,
  hydrateCreatedOrdersFromTx,
  hydrateFulfillmentFromTx,
} from "./settle.js";

export function belongsToCaller(intentAccountId: string | null, callerAccountId: string): boolean {
  return intentAccountId !== null && intentAccountId === callerAccountId;
}

export const NOT_THE_REQUESTERS_SIGNATURE = "That signature is not from the wallet this intent was built for";

export function signatureIsRefused(proof: VerifyResult): boolean {
  return !proof.ok && proof.reason === "invalid";
}

export function registerLifecycleRoutes(intents: Hono<AppEnv>): void {

  intents.get("/:id", async (c) => {
    const { id } = c.req.param();
    const intent = await prisma.transactionIntent.findUnique({ where: { id } });
    if (!intent) return c.json({ error: "Intent not found" }, 404);

    if (!belongsToCaller(intent.accountId, c.get("account").id)) {
      return c.json({ error: "Intent not found" }, 404);
    }

    if (intent.expiresAt < new Date() && intent.status === "PENDING") {
      const { count } = await prisma.transactionIntent.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      if (count > 0) intent.status = "EXPIRED";
    }

    return c.json({ data: intent });
  });

  intents.patch("/:id/signature", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => null);

    const parsedBody = signatureSchema.safeParse(body);
    if (!parsedBody.success) {
      return c.json({ error: "Invalid body", details: parsedBody.error.flatten() }, 400);
    }

    const intent = await prisma.transactionIntent.findUnique({ where: { id } });
    if (!intent) return c.json({ error: "Intent not found" }, 404);

    if (!belongsToCaller(intent.accountId, c.get("account").id)) {
      return c.json({ error: "Intent not found" }, 404);
    }

    if (intent.type === "MINT" || intent.type === "CREATE_COLLECTION" || intent.type === "FULFILL_ORDER") {
      return c.json({ error: "Intent type does not require a signature" }, 400);
    }
    if (intent.status !== "PENDING") {
      return c.json({ error: `Intent is ${intent.status}` }, 409);
    }

    let proof: VerifyResult;
    try {
      proof = await verifyWalletSignature({
        chain: intent.chain,
        address: intent.requester,
        typedData: intent.typedData,
        signature: parsedBody.data.signature,
      });
    } catch (err) {
      log.warn({ err, id, requester: intent.requester }, "Intent signature accepted unproven: the chain could not be read");
      proof = { ok: false, reason: "not_deployed" };
    }

    if (signatureIsRefused(proof)) {
      log.warn({ id, requester: intent.requester }, "Intent signature refused: it is not the requester's");
      return c.json({ error: NOT_THE_REQUESTERS_SIGNATURE }, 403);
    }
    if (!proof.ok) {
      log.warn({ id, requester: intent.requester }, "Intent signature accepted unproven: the wallet is not on chain yet");
    }

    const populatedCalls = buildPopulatedCalls(
      intent.type,
      (intent.typedData as Record<string, unknown> & { message: Record<string, unknown> }).message,
      intent.calls as { contractAddress: string; entrypoint: string; calldata: string[] }[],
      parsedBody.data.signature
    );

    const updated = await prisma.transactionIntent.update({
      where: { id },
      data: { signature: parsedBody.data.signature, status: "SIGNED", calls: populatedCalls as PrismaTypes.InputJsonValue },
    });

    log.info({ id, type: intent.type }, "Intent signed — calls populated, ready for client submission");
    return c.json({ data: updated });
  });

  intents.post("/:id/hydrate", async (c) => {
    const { id } = c.req.param();
    const intent = await prisma.transactionIntent.findUnique({ where: { id } });
    if (!intent) return c.json({ error: "Intent not found" }, 404);

    if (!belongsToCaller(intent.accountId, c.get("account").id)) {
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

    if (!belongsToCaller(intent.accountId, c.get("account").id)) {
      return c.json({ error: "Intent not found" }, 404);
    }

    if (!MARKETPLACE_INTENT_TYPES.has(intent.type) && !RECEIPT_HYDRATED_INTENT_TYPES.has(intent.type)) {
      return c.json({ error: "Intent type does not require tx confirmation" }, 400);
    }

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

    verifyAndSettle(id, txHash).catch((err) => {
      log.error({ err, id, txHash }, "verifyAndSettle threw unexpectedly");
    });

    log.info({ id, txHash }, "Intent submitted for background verification");
    return c.json({ data: updated }, 202);
  });
}
