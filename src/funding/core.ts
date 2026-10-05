import { x402Config } from "../config/x402.js";
import type { FundingIntentRecord, FundingStore, VerifiedPayment } from "./types.js";

export const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class FundingError extends Error {
  constructor(
    readonly code: "unknown_method" | "not_found" | "rejected",
    message: string,
  ) {
    super(message);
    this.name = "FundingError";
  }
}

export function creditsForUsdcAtomic(valueUsdcAtomic: bigint, multiplier: number): number {
  return Math.floor(Number(valueUsdcAtomic / x402Config.usdcAtomicPerCredit) * multiplier);
}

export async function createIntent(
  store: FundingStore,
  input: { apiCreditsId: string; method: string; params: Record<string, unknown> },
  now: Date = new Date(),
): Promise<FundingIntentRecord> {
  return store.create({ ...input, expiresAt: new Date(now.getTime() + INTENT_TTL_MS) });
}

export interface SettleDeps {
  store: FundingStore;
  mdlnMultiplier: (payer: string) => Promise<number>;
}

export type SettleResult =
  | { ok: true; credited: number; paymentId: string }
  | { ok: false; reason: "not-open" | "duplicate" };

export async function settleIntent(
  deps: SettleDeps,
  intent: FundingIntentRecord,
  verified: VerifiedPayment,
): Promise<SettleResult> {
  const multiplier = verified.payer ? await deps.mdlnMultiplier(verified.payer) : 1;
  const credited = creditsForUsdcAtomic(verified.valueUsdcAtomic, multiplier);
  if (credited <= 0) return { ok: false, reason: "not-open" };

  const result = await deps.store.settle({ intent, verified, credited, multiplier });
  if (result.outcome === "settled") return { ok: true, credited, paymentId: result.paymentId };
  return { ok: false, reason: result.outcome };
}
