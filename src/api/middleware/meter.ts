import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { randomBytes } from "crypto";
import { chargeForRequest as defaultChargeForRequest } from "../../payments/pricing.js";
import { debitCredits as defaultDebitCredits, refundCredits as defaultRefundCredits } from "../../payments/credits.js";
import { billedUnits, recordUsage as defaultRecordUsage } from "../../payments/usage.js";
import { buildPaymentRequired, decodePaymentHeader, settlePayment as defaultSettlePayment } from "../../payments/x402.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { severityFor, thresholdCrossed } from "../../payments/balance-warning.js";

const log = createLogger("middleware:meter");
const SCHEMES = [new StarknetUsdcScheme()];

export interface MeterDeps {
  chargeForRequest: typeof defaultChargeForRequest;
  debitCredits: typeof defaultDebitCredits;
  refundCredits: typeof defaultRefundCredits;
  settlePayment: typeof defaultSettlePayment;
  recordUsage: typeof defaultRecordUsage;
}

export function meter(deps: MeterDeps = {
  chargeForRequest: defaultChargeForRequest,
  debitCredits: defaultDebitCredits,
  refundCredits: defaultRefundCredits,
  settlePayment: defaultSettlePayment,
  recordUsage: defaultRecordUsage,
}): MiddlewareHandler<AppEnv> {
  const { chargeForRequest, debitCredits, refundCredits, settlePayment, recordUsage } = deps;
  return async (c, next) => {

    const charge = await chargeForRequest(c.req.method, c.req.path, {
      getBody: () => c.req.json().catch(() => null),
    });
    if (charge === null) return next();
    const cost = charge.unitCredits * charge.units;

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

    const remaining = Math.max(0, apiClient.creditBalance - cost);
    c.header("X-Credits-Remaining", String(remaining));
    log.debug({ apiClient: apiClient.id, cost, path: c.req.path }, "metered");

    const crossed = thresholdCrossed(apiClient.creditBalance, remaining);
    if (crossed !== null) {
      const line = { apiClient: apiClient.id, remaining, threshold: crossed, path: c.req.path };
      if (severityFor(crossed) === "error") {
        log.error(line, "Credit balance critical — requests will start returning 402");
      } else {
        log.warn(line, "Credit balance falling");
      }
    }

    const settle = async (units: number, status: number) => {
      const kept = charge.unitCredits * units;
      const owed = cost - kept;
      if (owed > 0) {
        await refundCredits(apiClient.id, owed).catch((refundErr) =>
          log.error({ refundErr, apiClient: apiClient.id, owed, path: c.req.path }, "refund of unused hold failed"),
        );
      }
      if (kept > 0) {
        c.header("X-Credits-Remaining", String(Math.max(0, apiClient.creditBalance - kept)));
      }
      await recordUsage({
        apiClientId: apiClient.id,
        actionKey: charge.actionKey,
        chain: charge.chain,
        service: charge.service,
        unitCredits: charge.unitCredits,
        units,
        credits: kept,
        method: c.req.method,
        path: c.req.path,
        status,
      }).catch((usageErr) =>
        log.error({ usageErr, apiClient: apiClient.id, kept, path: c.req.path }, "usage record failed"),
      );
    };

    try {
      await next();
    } catch (err) {
      await settle(0, 500);
      throw err;
    }
    await settle(c.res.status >= 500 ? 0 : billedUnits(c, charge.units), c.res.status);
  };
}

function newNonce(): string {
  return randomBytes(12).toString("hex");
}
