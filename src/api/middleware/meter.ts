import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { randomBytes } from "crypto";
import { costForRequest as defaultCostForRequest } from "../../payments/pricing.js";
import { debitCredits as defaultDebitCredits } from "../../payments/credits.js";
import { buildPaymentRequired, decodePaymentHeader, settlePayment as defaultSettlePayment } from "../../payments/x402.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:meter");
const SCHEMES = [new StarknetUsdcScheme()];

/** Injectable collaborators — tests pass stubs instead of mocking modules. */
export interface MeterDeps {
  costForRequest: typeof defaultCostForRequest;
  debitCredits: typeof defaultDebitCredits;
  settlePayment: typeof defaultSettlePayment;
}

/**
 * Pay-per-use metering. Placed AFTER apiKeyAuth on /v1/*. Resolves a credit cost
 * for the route (null = unmetered → skip), funds via X-PAYMENT if present, then
 * atomically debits. On insufficient funds returns 402 + x402 paymentRequirements.
 */
export function meter(deps: MeterDeps = {
  costForRequest: defaultCostForRequest,
  debitCredits: defaultDebitCredits,
  settlePayment: defaultSettlePayment,
}): MiddlewareHandler<AppEnv> {
  const { costForRequest, debitCredits, settlePayment } = deps;
  return async (c, next) => {
    const cost = costForRequest(c.req.method, c.req.path);
    if (cost === null) return next(); // unmetered route

    const account = c.get("account");
    if (!account) return c.json({ error: "Unauthorized" }, 401);

    // If the agent supplied a payment, settle it first so the debit can succeed.
    const header = c.req.header("x-payment");
    if (header) {
      const payload = decodePaymentHeader(header);
      const scheme = payload && SCHEMES.find((s) => s.scheme === payload.scheme && s.network === payload.network);
      if (payload && scheme) {
        const settled = await settlePayment(scheme, account.id, payload);
        if (!settled.ok) {
          c.header("X-Credits-Remaining", "0");
          return c.json(
            buildPaymentRequired(SCHEMES, {
              costCredits: cost,
              resource: c.req.path,
              nonce: newNonce(),
              error: settled.reason,
            }),
            402,
          );
        }
        c.header(
          "X-Payment-Response",
          Buffer.from(JSON.stringify({ credited: settled.creditedAmount }), "utf8").toString("base64"),
        );
      }
    }

    const paid = await debitCredits(account.id, cost);
    if (!paid) {
      c.header("X-Credits-Remaining", "0");
      return c.json(
        buildPaymentRequired(SCHEMES, { costCredits: cost, resource: c.req.path, nonce: newNonce() }),
        402,
      );
    }

    c.header("X-Credits-Remaining", "deducted"); // exact remaining is read via /v1/portal/me
    log.debug({ account: account.id, cost, path: c.req.path }, "metered");
    return next();
  };
}

function newNonce(): string {
  return randomBytes(12).toString("hex");
}
