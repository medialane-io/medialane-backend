

import { normalizeAddress } from "@medialane/sdk";

export function buildCoinListWhere(opts: { service?: string; creator?: string; chainFilter?: { chain: import("@prisma/client").Chain } | "all" }) {
  const cf = opts.chainFilter ?? { chain: "STARKNET" as const };

  const creatorChain = cf === "all" ? "STARKNET" : cf.chain;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    isHidden: false,
    ...(opts.service ? { service: opts.service } : {}),
    ...(opts.creator ? { creator: normalizeAddress(creatorChain, opts.creator) } : {}),
  };
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
