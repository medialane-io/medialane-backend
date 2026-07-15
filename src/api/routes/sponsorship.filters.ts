// Pure where-clause builders — no DB/config imports beyond the SDK's
// normalizer, so these stay unit-testable without the full backend env
// (mirrors coins.filters.ts).
import { normalizeAddress } from "@medialane/sdk";
import type { Chain } from "@prisma/client";

type ChainFilter = { chain: Chain } | "all";

export function buildOfferListWhere(opts: {
  chainFilter: ChainFilter;
  nftContract?: string;
  author?: string;
  open?: boolean;
}) {
  const cf = opts.chainFilter;
  const addrChain = cf === "all" ? "STARKNET" : cf.chain;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    ...(opts.nftContract ? { nftContract: normalizeAddress(addrChain, opts.nftContract) } : {}),
    ...(opts.author ? { author: normalizeAddress(addrChain, opts.author) } : {}),
    ...(opts.open !== undefined ? { open: opts.open } : {}),
  };
}

export function buildProposalListWhere(opts: {
  chainFilter: ChainFilter;
  nftContract?: string;
  proposer?: string;
  open?: boolean;
}) {
  const cf = opts.chainFilter;
  const addrChain = cf === "all" ? "STARKNET" : cf.chain;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    ...(opts.nftContract ? { nftContract: normalizeAddress(addrChain, opts.nftContract) } : {}),
    ...(opts.proposer ? { proposer: normalizeAddress(addrChain, opts.proposer) } : {}),
    ...(opts.open !== undefined ? { open: opts.open } : {}),
  };
}

export function buildLicenseListWhere(opts: {
  chainFilter: ChainFilter;
  author?: string;
  assetContract?: string;
  assetTokenId?: string;
}) {
  const cf = opts.chainFilter;
  const addrChain = cf === "all" ? "STARKNET" : cf.chain;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    ...(opts.author ? { author: normalizeAddress(addrChain, opts.author) } : {}),
    ...(opts.assetContract ? { assetContract: normalizeAddress(addrChain, opts.assetContract) } : {}),
    ...(opts.assetTokenId ? { assetTokenId: opts.assetTokenId } : {}),
  };
}
