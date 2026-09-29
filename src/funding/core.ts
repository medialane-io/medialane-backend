import { x402Config } from "../config/x402.js";
import type { FundingIntentRecord, FundingStore, VerifiedPayment } from "./types.js";

export const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_OPEN_INTENTS = 5;
/**
 * How long after its authorization deadline an authorized intent can still match a transfer.
 * Bounded so an abandoned intent cannot count against the account forever, or capture a
 * transfer the payer makes months later for something else.
 */
export const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class FundingError extends Error {
  constructor(
    readonly code: "too_many_open" | "unknown_method" | "not_found" | "rejected",
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
  input: { apiClientId: string; method: string; params: Record<string, unknown> },
  now: Date = new Date(),
): Promise<FundingIntentRecord> {
  if ((await store.countOpen(input.apiClientId, now)) >= MAX_OPEN_INTENTS) {
    throw new FundingError("too_many_open", "Finish or wait out your open top-ups before starting another.");
  }
  return store.create({ ...input, expiresAt: new Date(now.getTime() + INTENT_TTL_MS) });
}

export interface SettleDeps {
  store: FundingStore;
  mdlnMultiplier: (payer: string) => Promise<number>;
}

export type SettleResult =
  | { ok: true; credited: number; paymentId: string }
  | { ok: false; reason: "not-open" | "duplicate" };

/**
 * Credits the intent's account for a verified payment. A payment made before an intent's
 * window closed is still credited afterwards: the money is real, so expiry only limits
 * how long an intent can be authorized, never whether a made transfer counts.
 */
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
