

import type { Hono } from "hono";
import { type Prisma as PrismaTypes, type TransactionIntent } from "@prisma/client";
import prisma from "../../../db/client.js";
import { buildPopulatedCalls } from "../../../orchestrator/submit.js";
import { verifyWalletSignature, type VerifyResult } from "../../../auth/verify.js";
import type { AppEnv } from "../../../types/hono.js";
import { starknet } from "@medialane/sdk/contract";
import {
  log,
  MARKETPLACE_INTENT_TYPES,
  RECEIPT_HYDRATED_INTENT_TYPES,
} from "./_shared.js";

const { confirmSchema, signatureSchema } = starknet;
import {
  verifyAndSettle,
} from "./settle.js";
import { notFound } from "../../http/errors.js";
import { validated } from "../../http/validate.js";

async function ownIntent(c: { get(key: "account"): { id: string } }, id: string): Promise<TransactionIntent> {
  const intent = await prisma.transactionIntent.findFirst({ where: { id, accountId: c.get("account").id } });
  if (!intent) throw notFound("Intent");
  return intent;
}

export const NOT_THE_REQUESTERS_SIGNATURE = "That signature is not from the wallet this intent was built for";

export function signatureIsRefused(proof: VerifyResult): boolean {
  return !proof.ok && proof.reason === "invalid";
}

export function registerLifecycleRoutes(intents: Hono<AppEnv>): void {

  intents.get("/:id", async (c) => {
    const { id } = c.req.param();
    const intent = await ownIntent(c, id);

    if (intent.expiresAt < new Date() && intent.status === "PENDING") {
      const { count } = await prisma.transactionIntent.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      if (count > 0) intent.status = "EXPIRED";
    }

    return c.json({ data: intent });
  });

  intents.patch("/:id/signature", validated("json", signatureSchema), async (c) => {
    const { id } = c.req.param();
    const parsedBody = c.req.valid("json");

    const intent = await ownIntent(c, id);

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
        signature: parsedBody.signature,
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
      parsedBody.signature
    );

    const updated = await prisma.transactionIntent.update({
      where: { id },
      data: { signature: parsedBody.signature, status: "SIGNED", calls: populatedCalls as PrismaTypes.InputJsonValue },
    });

    log.info({ id, type: intent.type }, "Intent signed — calls populated, ready for client submission");
    return c.json({ data: updated });
  });

  intents.patch("/:id/confirm", validated("json", confirmSchema), async (c) => {
    const { id } = c.req.param();
    const parsed = c.req.valid("json");

    const { txHash } = parsed;
    const intent = await ownIntent(c, id);

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
