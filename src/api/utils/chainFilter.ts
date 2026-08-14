import type { Chain } from "@prisma/client";

const CHAINS = new Set(["STARKNET", "ETHEREUM", "SOLANA", "BASE", "STELLAR"]);

export function parseChainFilter(raw: string | undefined): { chain: Chain } | "all" | null {
  if (!raw) return { chain: "STARKNET" as Chain };
  if (raw === "all") return "all";
  const upper = raw.toUpperCase();
  if (CHAINS.has(upper)) return { chain: upper as Chain };
  return null;
}

export function parseSingleChain(raw: string | undefined): Chain | null {
  const filter = parseChainFilter(raw);
  return filter && filter !== "all" ? filter.chain : null;
}

export function chainWhere(filter: { chain: Chain } | "all"): { chain?: Chain } {
  return filter === "all" ? {} : { chain: filter.chain };
}
