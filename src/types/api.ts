// --- API Request/Response DTOs ---

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface OrdersQuery extends PaginationParams {
  status?: "ACTIVE" | "FULFILLED" | "CANCELLED" | "EXPIRED";
  collection?: string;
  currency?: string;
  sort?: "price_asc" | "price_desc" | "recent";
  offerer?: string;
}

export interface TokensQuery extends PaginationParams {
  owner?: string;
  wait?: boolean;
}

export interface ActivitiesQuery extends PaginationParams {
  address?: string;
  type?: "transfer" | "sale" | "listing" | "offer";
}

// Intent request bodies
export interface CreateListingIntentBody {
  offerer: string;
  nftContract: string;
  tokenId: string;
  currency: string;
  price: string;
  endTime: number;
  salt?: string;
  /** Number of units to list. When present the intent uses the Medialane1155 contract (ERC-1155). */
  amount?: string;
}

export interface MakeOfferIntentBody {
  offerer: string;
  nftContract: string;
  tokenId: string;
  currency: string;
  price: string;
  endTime: number;
  salt?: string;
  /** Caller hint — "ERC1155" creates the bid on the ERC-1155 marketplace. */
  tokenStandard?: string;
  /** ERC-1155 only: number of units the buyer wants. Defaults to 1. */
  quantity?: string;
}

export interface CounterOfferIntentBody {
  sellerAddress:   string;  // normalized 0x address
  nftContract:     string;  // from original bid's considerationToken
  tokenId:         string;  // from original bid's considerationIdentifier
  currencyAddress: string;  // from original bid's offerToken
  priceRaw:        string;  // raw wei bigint string — NOT human-readable
  durationSeconds: number;
  salt?:           string;
}

export interface FulfillOrderIntentBody {
  fulfiller: string;
  orderHash: string;
  /** Caller hint — "ERC1155" forces 1155 routing even if the order isn't in the DB yet */
  tokenStandard?: string;
  /** ERC-1155 only: number of units to purchase (1 ≤ quantity ≤ remaining_amount). Defaults to 1. */
  quantity?: string;
}

export interface CancelOrderIntentBody {
  offerer: string;
  orderHash: string;
  /** Caller hint — "ERC1155" forces 1155 routing even if the order isn't in the DB yet */
  tokenStandard?: string;
}

export interface MintIntentBody {
  /** Collection owner wallet address — must be the collection owner to mint */
  owner: string;
  recipient: string;
  /**
   * Registry-style mint (mip-erc721/ip-erc721, the default when
   * collectionContract is omitted or resolves to one of those services):
   * required, plus tokenUri.
   */
  collectionId?: string;
  tokenUri?: string;
  /** EIP-2981 royalty in bps (0–10_000), receiver = creator. Registry mint only. */
  royaltyBps?: number;
  /**
   * Per-creator-factory mint (mip-erc1155/ip-tickets/ip-club, resolved from
   * collectionContract's indexed service): mip-erc1155 needs tokenUri + value
   * (mints a NEW edition); ip-tickets/ip-club need an existing tokenId + amount
   * (mints more of an already-created tier — see CREATE_TIER for creating one).
   */
  tokenId?: string;
  amount?: string;
  value?: string;
  /** Which collection to mint into. Omitted = the shared mip-erc721 registry. */
  collectionContract?: string;
}

export interface CreateCollectionIntentBody {
  owner: string;
  name: string;
  symbol: string;
  baseUri: string;
  description?: string;
  /** Optional IPFS image URI (ipfs://...) for the collection cover image */
  image?: string;
  /** Optional: override the default collection contract address (registry path only) */
  collectionContract?: string;
  /**
   * Which service's factory to deploy. Omitted = today's default (the shared
   * mip-erc721 registry — no new deploy, just a registry entry). One of
   * "mip-erc1155" | "ip-tickets" | "ip-club" deploys a new per-creator
   * contract via that service's factory instead.
   */
  service?: string;
}

export interface CreateTierIntentBody {
  /** Wallet that must own the collection — verified on-chain before building calldata. */
  owner: string;
  /** The deployed per-creator collection contract (from a prior CREATE_COLLECTION deploy). */
  collection: string;
  /** "ip-tickets" | "ip-club" — which entrypoint (create_ticket / create_membership) to call. */
  service: string;
  maxSupply: string;
  /** Unix seconds. Omit both for a lifetime tier (tickets) / no validity window (club). */
  startTime?: number;
  endTime?: number;
  royaltyBps: number;
  metadataUri: string;
}

export interface SubmitSignatureBody {
  signature: string[];
}

// Response shapes
export interface ApiResponse<T> {
  data: T;
  meta?: {
    page: number;
    limit: number;
    total?: number;
  };
}

export interface ApiError {
  error: string;
  message?: string;
  code?: string;
}
