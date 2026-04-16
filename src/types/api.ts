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
}

export interface CancelOrderIntentBody {
  offerer: string;
  orderHash: string;
}

export interface MintIntentBody {
  /** Collection owner wallet address — must be the collection owner to mint */
  owner: string;
  collectionId: string;
  recipient: string;
  tokenUri: string;
  /** Optional: override the default collection contract address */
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
  /** Optional: override the default collection contract address */
  collectionContract?: string;
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
