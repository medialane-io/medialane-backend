/**
 * Per-request credit cost. Returns null for routes that must NOT be metered
 * (account self-service, auth). Everything else defaults to 1 (read); specific
 * prefixes override upward per the published category model.
 */

// Prefixes that are never metered (managed by the account's own key, no charge).
const UNMETERED_PREFIXES = ["/v1/portal", "/v1/auth"];

// method + prefix → cost. First match wins; order most-specific first.
const COST_RULES: ReadonlyArray<{ method?: string; prefix: string; cost: number }> = [
  { method: "POST", prefix: "/v1/intents", cost: 5 }, // SNIP-12 trade intents
];

const DEFAULT_COST = 1; // reads / queries

export function costForRequest(method: string, path: string): number | null {
  if (UNMETERED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    return null;
  }
  for (const rule of COST_RULES) {
    if (rule.method && rule.method !== method.toUpperCase()) continue;
    if (path === rule.prefix || path.startsWith(rule.prefix + "/")) {
      return rule.cost;
    }
  }
  return DEFAULT_COST;
}

/** Public cost table for the discovery endpoint. */
export const PRICING_TABLE = {
  default: DEFAULT_COST,
  rules: COST_RULES,
  unmetered: UNMETERED_PREFIXES,
} as const;
