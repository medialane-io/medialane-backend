import type { Chain } from "@prisma/client";

const CHAINS = new Set(["STARKNET", "ETHEREUM", "SOLANA", "BASE", "STELLAR", "BITCOIN"]);

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

/** Prisma where-fragment for a parsed filter ("all" → empty object). */
export function chainWhere(filter: { chain: Chain } | "all"): { chain?: Chain } {
  return filter === "all" ? {} : { chain: filter.chain };
}
