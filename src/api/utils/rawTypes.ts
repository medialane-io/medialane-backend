import type { Chain, OrderStatus, MetadataStatus, TokenStandard } from "@prisma/client";

export interface RawOrderRow {
  id: string;
  chain: Chain;
  orderHash: string;
  offerer: string;
  offerItemType: string;
  offerToken: string;
  offerIdentifier: string;
  offerStartAmount: string;
  offerEndAmount: string;
  considerationItemType: string;
  considerationToken: string;
  considerationIdentifier: string;
  considerationStartAmount: string;
  considerationEndAmount: string;
  considerationRecipient: string;
  startTime: bigint;
  endTime: bigint;
  status: OrderStatus;
  fulfiller: string | null;
  createdBlockNumber: bigint;
  createdTxHash: string;
  fulfilledTxHash: string | null;
  cancelledTxHash: string | null;
  nftContract: string | null;
  nftTokenId: string | null;
  priceRaw: string | null;
  priceFormatted: string | null;
  currencySymbol: string | null;
  parentOrderHash: string | null;
  counterOfferMessage: string | null;
  marketplaceContract: string | null;
  marketplaceService: string | null;
  remainingAmount: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RawCollectionRow {
  id: string;
  chain: Chain;
  contractAddress: string;
  collectionId: string | null;
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  baseUri: string | null;
  owner: string | null;
  metadataStatus: MetadataStatus;
  startBlock: bigint;
  isFeatured: boolean;
  isHidden: boolean;
  standard: TokenStandard;
  service: string;
  claimedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  floorPrice: string | null;
  floorCurrency: string | null;
  totalVolume: string | null;
  volumeCurrency: string | null;
  holderCount: number;
  totalSupply: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RawCountRow {
  count: bigint;
}

export interface RawTokenRow {
  id: string;
  chain: Chain;
  contractAddress: string;
  tokenId: string;
  tokenUri: string | null;
  metadataStatus: MetadataStatus;
  isHidden: boolean;
  name: string | null;
  description: string | null;
  image: string | null;
  animationUrl: string | null;
  attributes: unknown;
  ipType: string | null;
  licenseType: string | null;
  commercialUse: boolean | null;
  author: string | null;
  createdAt: Date;
  updatedAt: Date;
  minPrice: string | null;
}

export interface RawSearchTokenRow {
  contractAddress: string;
  tokenId: string;
  name: string | null;
  image: string | null;
  metadataStatus: MetadataStatus;
  rank: number;
}

export interface RawSearchCollectionRow {
  contractAddress: string;
  name: string | null;
  image: string | null;
  totalSupply: number;
  floorPrice: string | null;
  floorCurrency: string | null;
  holderCount: number;
  collectionId: string | null;
  rank: number;
}
