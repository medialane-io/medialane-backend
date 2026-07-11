import type { Chain } from "@prisma/client";

// The chains a read filter accepts — the Prisma enum MINUS Bitcoin: no
// ingestor writes BITCOIN rows and normalizeAddress throws for it (chain-
// sovereignty: Bitcoin is Horizon-gated), so accepting it turned keyed reads
// into 500s. Re-add when Bitcoin rows can actually exist.
const CHAINS = new Set(["STARKNET", "ETHEREUM", "SOLANA", "BASE", "STELLAR"]);

/**
 * Parse the `?chain=` read filter (platform-federation spec §3.4).
 * - omitted → STARKNET (zero breakage for existing consumers)
 * - a Chain enum value → that chain
 * - "all" → no chain clause (cross-chain aggregation for list reads)
 * Returns null for invalid values (callers respond 400).
 */
export function parseChainFilter(raw: string | undefined): { chain: Chain } | "all" | null {
  if (!raw) return { chain: "STARKNET" as Chain };
  if (raw === "all") return "all";
  const upper = raw.toUpperCase();
  if (CHAINS.has(upper)) return { chain: upper as Chain };
  return null;
}

/**
 * Parse `?chain=` for detail/keyed reads (unique lookups, address
 * normalization) where cross-chain aggregation makes no sense: a single Chain
 * only — omitted → STARKNET, "all" or invalid → null (callers respond 400).
 */
export function parseSingleChain(raw: string | undefined): Chain | null {
  const filter = parseChainFilter(raw);
  return filter && filter !== "all" ? filter.chain : null;
}

/** Prisma where-fragment for a parsed filter ("all" → empty object). */
export function chainWhere(filter: { chain: Chain } | "all"): { chain?: Chain } {
  return filter === "all" ? {} : { chain: filter.chain };
}
