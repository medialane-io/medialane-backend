import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { randomBytes } from "crypto";
import { chargeForRequest as defaultChargeForRequest } from "../../payments/pricing.js";
import { charge as defaultCharge, returnCharge as defaultReturnCharge } from "../../payments/ledger.js";
import { billedCredits, billedUnits } from "../../payments/usage.js";
import { buildPaymentRequired, decodePaymentHeader, settlePayment as defaultSettlePayment } from "../../payments/x402.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { severityFor, thresholdCrossed } from "../../payments/balance-warning.js";

const log = createLogger("middleware:meter");
const SCHEMES = [new StarknetUsdcScheme()];

export interface MeterDeps {
  chargeForRequest: typeof defaultChargeForRequest;
  charge: typeof defaultCharge;
  returnCharge: typeof defaultReturnCharge;
  settlePayment: typeof defaultSettlePayment;
}

export function meter(deps: MeterDeps = {
  chargeForRequest: defaultChargeForRequest,
  charge: defaultCharge,
  returnCharge: defaultReturnCharge,
  settlePayment: defaultSettlePayment,
}): MiddlewareHandler<AppEnv> {
  const { chargeForRequest, charge: chargeCredits, returnCharge, settlePayment } = deps;
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

    const paid = await chargeCredits(apiCredits.id, cost);
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

    const settle = (units: number, credits?: number) => {
      const kept = Math.min(cost, credits ?? charge.unitCredits * units);
      const owed = cost - kept;
      if (kept > 0) {
        c.header("X-Credits-Remaining", String(Math.max(0, apiCredits.creditBalance - kept)));
      }
      if (owed > 0) {
        void returnCharge(apiCredits.id, owed).catch((settleErr) =>
          log.error({ settleErr, apiCredits: apiCredits.id, kept, owed, path: c.req.path }, "usage settlement failed"),
        );
      }
    };

    try {
      await next();
    } catch (err) {
      settle(0);
      throw err;
    }
    settle(billedUnits(c, c.res.status >= 500 ? 0 : charge.units), billedCredits(c));
  };
}

function newNonce(): string {
  return randomBytes(12).toString("hex");
}
