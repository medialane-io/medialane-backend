

import { addressWhere, type ChainFilter } from "../utils/chainFilter.js";
type OwnedPair = { contractAddress: string; tokenId: string };

function ownedPairsOr(ownedPairs?: OwnedPair[]) {
  if (!ownedPairs) return {};
  return { OR: ownedPairs.map((p) => ({ nftContract: p.contractAddress, tokenId: p.tokenId })) };
}

export function buildOfferListWhere(opts: {
  chainFilter: ChainFilter;
  nftContract?: string;
  author?: string;
  open?: boolean;
  ownedPairs?: OwnedPair[];
}) {
  const cf = opts.chainFilter;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    ...(opts.nftContract ? { nftContract: addressWhere(cf, opts.nftContract) } : {}),
    ...(opts.author ? { author: addressWhere(cf, opts.author) } : {}),
    ...(opts.open !== undefined ? { open: opts.open } : {}),
    ...ownedPairsOr(opts.ownedPairs),
  };
}

export function buildProposalListWhere(opts: {
  chainFilter: ChainFilter;
  nftContract?: string;
  proposer?: string;
  open?: boolean;
  ownedPairs?: OwnedPair[];
}) {
  const cf = opts.chainFilter;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    ...(opts.nftContract ? { nftContract: addressWhere(cf, opts.nftContract) } : {}),
    ...(opts.proposer ? { proposer: addressWhere(cf, opts.proposer) } : {}),
    ...(opts.open !== undefined ? { open: opts.open } : {}),
    ...ownedPairsOr(opts.ownedPairs),
  };
}

export function buildLicenseListWhere(opts: {
  chainFilter: ChainFilter;
  author?: string;
  assetContract?: string;
  assetTokenId?: string;
}) {
  const cf = opts.chainFilter;
  return {
    ...(cf === "all" ? {} : { chain: cf.chain }),
    ...(opts.author ? { author: addressWhere(cf, opts.author) } : {}),
    ...(opts.assetContract ? { assetContract: addressWhere(cf, opts.assetContract) } : {}),
    ...(opts.assetTokenId ? { assetTokenId: opts.assetTokenId } : {}),
  };
}
