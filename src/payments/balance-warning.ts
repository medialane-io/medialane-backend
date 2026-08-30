// Credits are the ceiling on what any abuse can spend, which only works as a
// circuit breaker if someone finds out before it trips. Reaching zero returns
// 402 to every user of that app at once, so the useful signal is the approach,
// not the arrival.
export const BALANCE_THRESHOLDS = [50_000, 10_000, 1_000, 0] as const;

export type BalanceThreshold = (typeof BALANCE_THRESHOLDS)[number];

/**
 * The lowest threshold a balance has fallen to or below, or null while it is
 * still above all of them. Reported on the transition only: a balance sitting
 * under a threshold is not news every request, and log spam is how a real
 * warning gets missed.
 */
export function thresholdCrossed(before: number, after: number): BalanceThreshold | null {
  if (after >= before) return null;
  // Thresholds descend, so the last match is the most severe one this spend
  // passed. A drop from 60,000 to 500 has to report 500, not 50,000.
  let crossed: BalanceThreshold | null = null;
  for (const threshold of BALANCE_THRESHOLDS) {
    if (before > threshold && after <= threshold) crossed = threshold;
  }
  return crossed;
}

export function severityFor(threshold: BalanceThreshold): "warn" | "error" {
  return threshold <= 1_000 ? "error" : "warn";
}
