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

export interface FulfillOrderIntentBody {
  fulfiller: string;
  orderHash: string;
}

export interface CancelOrderIntentBody {
  offerer: string;
  orderHash: string;
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
