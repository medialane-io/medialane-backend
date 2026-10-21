import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { randomBytes } from "crypto";
import { chargeForRequest as defaultChargeForRequest } from "../../payments/pricing.js";
import { settleUsage as defaultSettleUsage, spend as defaultSpend } from "../../payments/ledger.js";
import { billedCredits, billedUnits } from "../../payments/usage.js";
import { buildPaymentRequired, decodePaymentHeader, settlePayment as defaultSettlePayment } from "../../payments/x402.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { severityFor, thresholdCrossed } from "../../payments/balance-warning.js";

const log = createLogger("middleware:meter");
const SCHEMES = [new StarknetUsdcScheme()];

export interface MeterDeps {
  chargeForRequest: typeof defaultChargeForRequest;
  spend: typeof defaultSpend;
  settleUsage: typeof defaultSettleUsage;
  settlePayment: typeof defaultSettlePayment;
}

export function meter(deps: MeterDeps = {
  chargeForRequest: defaultChargeForRequest,
  spend: defaultSpend,
  settleUsage: defaultSettleUsage,
  settlePayment: defaultSettlePayment,
}): MiddlewareHandler<AppEnv> {
  const { chargeForRequest, spend, settleUsage, settlePayment } = deps;
  return async (c, next) => {

    const charge = await chargeForRequest(c.req.method, c.req.path, {
      getBody: () => c.req.json().catch(() => null),
    });
    if (charge === null) return next();
    const cost = charge.unitCredits * charge.units;

    const apiCredits = c.get("apiCredits");
    if (!apiCredits) return c.json({ error: "Unauthorized" }, 401);

    const header = c.req.header("x-payment");
    if (header) {
      const payload = decodePaymentHeader(header);
      const scheme = payload && SCHEMES.find((s) => s.scheme === payload.scheme && s.network === payload.network);
      if (payload && scheme) {
        const settled = await settlePayment(scheme, apiCredits, payload);
        if (settled.ok) {
          c.header(
            "X-Payment-Response",
            Buffer.from(JSON.stringify({ credited: settled.creditedAmount }), "utf8").toString("base64"),
          );
        } else {
          log.warn(
            { apiCredits: apiCredits.id, reason: settled.reason, path: c.req.path },
            "payment settlement failed — falling through to credit balance",
          );
        }
      }
    }

    const paid = await spend(apiCredits.id, cost);
    if (!paid) {
      c.header("X-Credits-Remaining", "0");
      return c.json(
        { ...buildPaymentRequired(SCHEMES, { costCredits: cost, resource: c.req.path, nonce: newNonce() }), code: "credits_exhausted" },
        402,
      );
    }

    const remaining = Math.max(0, apiCredits.creditBalance - cost);
    c.header("X-Credits-Remaining", String(remaining));
    log.debug({ apiCredits: apiCredits.id, cost, path: c.req.path }, "metered");

    const crossed = thresholdCrossed(apiCredits.creditBalance, remaining);
    if (crossed !== null) {
      const line = { apiCredits: apiCredits.id, remaining, threshold: crossed, path: c.req.path };
      if (severityFor(crossed) === "error") {
        log.error(line, "Credit balance critical — requests will start returning 402");
      } else {
        log.warn(line, "Credit balance falling");
      }
    }

    const settle = (units: number, status: number, credits?: number) => {
      const kept = Math.min(cost, credits ?? charge.unitCredits * units);
      const owed = cost - kept;
      if (kept > 0) {
        c.header("X-Credits-Remaining", String(Math.max(0, apiCredits.creditBalance - kept)));
      }
      void settleUsage(
        {
          apiCreditsId: apiCredits.id,
          actionKey: charge.actionKey,
          chain: charge.chain,
          service: charge.service,
          unitCredits: charge.unitCredits,
          units,
          credits: kept,
          method: c.req.method,
          path: c.req.path,
          status,
        },
        owed,
      ).catch((settleErr) =>
        log.error({ settleErr, apiCredits: apiCredits.id, kept, owed, path: c.req.path }, "usage settlement failed"),
      );
    };

    try {
      await next();
    } catch (err) {
      settle(0, 500);
      throw err;
    }
    if (c.res.status >= 500) settle(0, c.res.status, 0);
    else settle(billedUnits(c, charge.units), c.res.status, billedCredits(c));
  };
}

function newNonce(): string {
  return randomBytes(12).toString("hex");
}
