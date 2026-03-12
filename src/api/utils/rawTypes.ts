import type { Chain, OrderStatus, MetadataStatus } from "@prisma/client";

/** Raw row returned by SELECT * FROM "Order" via $queryRaw */
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
  createdAt: Date;
  updatedAt: Date;
}

/** Raw row returned by SELECT * FROM "Collection" via $queryRaw */
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
  isKnown: boolean;
  floorPrice: string | null;
  totalVolume: string | null;
  holderCount: number;
  totalSupply: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Raw count row from SELECT COUNT(*) AS count */
export interface RawCountRow {
  count: bigint;
}

/** Raw row returned by full-text search on Token */
export interface RawSearchTokenRow {
  contractAddress: string;
  tokenId: string;
  name: string | null;
  image: string | null;
  owner: string;
  metadataStatus: MetadataStatus;
  rank: number;
}

/** Raw row returned by full-text search on Collection */
export interface RawSearchCollectionRow {
  contractAddress: string;
  name: string | null;
  image: string | null;
  totalSupply: number;
  floorPrice: string | null;
  holderCount: number;
  collectionId: string | null;
  rank: number;
}
