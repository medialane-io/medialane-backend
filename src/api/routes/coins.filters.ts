

import { normalizeAddress } from "@medialane/sdk";
import { DEFAULT_CHAIN } from "../../config/chains.js";
import { addressWhere, type ChainFilter } from "../utils/chainFilter.js";

export function buildCoinListWhere(opts: { service?: string; creator?: string; chainFilter?: ChainFilter }) {
  const cf = opts.chainFilter ?? { chain: DEFAULT_CHAIN };
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    isHidden: false,
    ...(opts.service ? { service: opts.service } : {}),
    ...(opts.creator ? { creator: addressWhere(cf, opts.creator) } : {}),
  };
}

export function buildCoinListOrderBy(sort?: string) {
  if (sort === "name") return { name: "asc" as const };
  return { createdAt: "desc" as const };
}

export function buildAdminCoinWhere(opts: { service?: string; search?: string }) {
  const where: Record<string, unknown> = { chain: "STARKNET" };
  if (opts.service) where.service = opts.service;
  if (opts.search) {
    const looksHex = /^0x[0-9a-fA-F]+$/.test(opts.search);
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { symbol: { contains: opts.search, mode: "insensitive" } },
      ...(looksHex ? [{ contractAddress: normalizeAddress("STARKNET", opts.search) }] : []),
    ];
  }
  return where;
}
