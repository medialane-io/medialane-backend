import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { randomBytes } from "crypto";
import { costForRequest as defaultCostForRequest } from "../../payments/pricing.js";
import { debitCredits as defaultDebitCredits, refundCredits as defaultRefundCredits } from "../../payments/credits.js";
import { buildPaymentRequired, decodePaymentHeader, settlePayment as defaultSettlePayment } from "../../payments/x402.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:meter");
const SCHEMES = [new StarknetUsdcScheme()];

export interface MeterDeps {
  costForRequest: typeof defaultCostForRequest;
  debitCredits: typeof defaultDebitCredits;
  refundCredits: typeof defaultRefundCredits;
  settlePayment: typeof defaultSettlePayment;
}

export function meter(deps: MeterDeps = {
  costForRequest: defaultCostForRequest,
  debitCredits: defaultDebitCredits,
  refundCredits: defaultRefundCredits,
  settlePayment: defaultSettlePayment,
}): MiddlewareHandler<AppEnv> {
  const { costForRequest, debitCredits, refundCredits, settlePayment } = deps;
  return async (c, next) => {

    const cost = await costForRequest(c.req.method, c.req.path, {
      getBody: () => c.req.json().catch(() => null),
    });
    if (cost === null) return next();

    const apiClient = c.get("apiClient");
    if (!apiClient) return c.json({ error: "Unauthorized" }, 401);

    const header = c.req.header("x-payment");
    if (header) {
      const payload = decodePaymentHeader(header);
      const scheme = payload && SCHEMES.find((s) => s.scheme === payload.scheme && s.network === payload.network);
      if (payload && scheme) {
        const settled = await settlePayment(scheme, apiClient, payload);
        if (settled.ok) {
          c.header(
            "X-Payment-Response",
            Buffer.from(JSON.stringify({ credited: settled.creditedAmount }), "utf8").toString("base64"),
          );
        } else {
          log.warn(
            { apiClient: apiClient.id, reason: settled.reason, path: c.req.path },
            "payment settlement failed — falling through to credit balance",
          );
        }
      }
    }

    const paid = await debitCredits(apiClient.id, cost);
    if (!paid) {
      c.header("X-Credits-Remaining", "0");
      return c.json(
        buildPaymentRequired(SCHEMES, { costCredits: cost, resource: c.req.path, nonce: newNonce() }),
        402,
      );
    }

    c.header("X-Credits-Remaining", String(Math.max(0, apiClient.creditBalance - cost)));
    log.debug({ apiClient: apiClient.id, cost, path: c.req.path }, "metered");

    try {
      await next();
    } catch (err) {
      await refundCredits(apiClient.id, cost).catch((refundErr) =>
        log.error({ refundErr, apiClient: apiClient.id, cost, path: c.req.path }, "refund after thrown handler failed"),
      );
      throw err;
    }
    if (c.res.status >= 500) {
      await refundCredits(apiClient.id, cost).catch((refundErr) =>
        log.error({ refundErr, apiClient: apiClient.id, cost, path: c.req.path }, "refund after 5xx failed"),
      );
    }
  };
}

function newNonce(): string {
  return randomBytes(12).toString("hex");
}
