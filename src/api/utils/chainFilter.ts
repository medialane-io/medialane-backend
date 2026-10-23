import type { Chain } from "@prisma/client";
import { DEFAULT_CHAIN, ENABLED_CHAINS } from "../../config/chains.js";

export type ChainFilter = { chain: Chain } | "all";

export function parseChainFilter(raw: string | undefined, enabled: readonly Chain[] = ENABLED_CHAINS): ChainFilter | null {
  if (!raw) return { chain: DEFAULT_CHAIN };
  if (raw === "all") return "all";
  const upper = raw.toUpperCase();
  const chain = enabled.find((c) => c === upper);
  return chain ? { chain } : null;
}

export function parseSingleChain(raw: string | undefined, enabled: readonly Chain[] = ENABLED_CHAINS): Chain | null {
  const filter = parseChainFilter(raw, enabled);
  return filter && filter !== "all" ? filter.chain : null;
}

export function chainWhere(filter: ChainFilter): { chain?: Chain } {
  return filter === "all" ? {} : { chain: filter.chain };
}
