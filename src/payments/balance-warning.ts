export const BALANCE_THRESHOLDS = [50_000, 10_000, 1_000, 0] as const;

export type BalanceThreshold = (typeof BALANCE_THRESHOLDS)[number];

export function thresholdCrossed(before: number, after: number): BalanceThreshold | null {
  if (after >= before) return null;
  let crossed: BalanceThreshold | null = null;
  for (const threshold of BALANCE_THRESHOLDS) {
    if (before > threshold && after <= threshold) crossed = threshold;
  }
  return crossed;
}

export function severityFor(threshold: BalanceThreshold): "warn" | "error" {
  return threshold <= 1_000 ? "error" : "warn";
}
