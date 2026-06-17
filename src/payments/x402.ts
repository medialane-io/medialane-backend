import { Prisma } from "@prisma/client";
import { x402Config } from "../config/x402.js";
import { creditTenant } from "./credits.js";
import { mdlnMultiplier } from "./mdln.js";
import type { PaymentRequirement, PaymentScheme, X402Payload } from "./schemes/types.js";

export interface PaymentRequiredBody {
  x402Version: 1;
  accepts: PaymentRequirement[];
  error?: string;
}

export function encodePaymentHeader(p: X402Payload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

export function decodePaymentHeader(header: string): X402Payload | null {
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (
      json &&
      typeof json.scheme === "string" &&
      typeof json.network === "string" &&
      typeof json.txHash === "string" &&
      typeof json.nonce === "string"
    ) {
      return json as X402Payload;
    }
    return null;
  } catch {
    return null;
  }
}

/** USDC atomic units owed for a given credit cost. */
export function priceAtomic(costCredits: number): bigint {
  return BigInt(costCredits) * x402Config.usdcAtomicPerCredit;
}

export function buildPaymentRequired(
  schemes: PaymentScheme[],
  args: { costCredits: number; resource: string; nonce: string; error?: string },
): PaymentRequiredBody {
  const amountAtomic = priceAtomic(args.costCredits);
  return {
    x402Version: 1,
    accepts: schemes.map((s) => s.buildRequirement({ amountAtomic, resource: args.resource, nonce: args.nonce })),
    ...(args.error ? { error: args.error } : {}),
  };
}

export interface SettleResult {
  ok: boolean;
  creditedAmount?: number;
  reason?: string;
}

/**
 * Verify an X-PAYMENT against `scheme` and, if valid, credit the tenant. Replays
 * are absorbed by the unique `proofNonce` on Payment — a unique violation means
 * the proof was already credited, which we treat as success-idempotent.
 */
export async function settlePayment(
  scheme: PaymentScheme,
  tenantId: string,
  payload: X402Payload,
): Promise<SettleResult> {
  const v = await scheme.verify(payload);
  if (!v.ok || v.amountAtomic === undefined || !v.proofNonce) {
    return { ok: false, reason: v.reason ?? "payment verification failed" };
  }

  const baseCredits = Number(v.amountAtomic / x402Config.usdcAtomicPerCredit);
  // MDLN bonus keyed on the verified on-chain payer. Never blocks settlement
  // (mdlnMultiplier returns 1.0 on any read failure or if MDLN is unconfigured).
  const multiplier = v.payer ? await mdlnMultiplier(v.payer) : 1.0;
  const creditedAmount = Math.floor(baseCredits * multiplier);

  try {
    await creditTenant({
      tenantId,
      amountAtomic: v.amountAtomic,
      creditedAmount,
      mdlnMultiplier: multiplier,
      scheme: scheme.scheme,
      network: scheme.network,
      asset: x402Config.usdcContract,
      txHash: payload.txHash,
      proofNonce: v.proofNonce,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: true, creditedAmount: 0, reason: "already credited" };
    }
    throw err;
  }
  return { ok: true, creditedAmount };
}
