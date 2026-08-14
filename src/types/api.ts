

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

export interface CreateListingIntentBody {
  offerer: string;
  nftContract: string;
  tokenId: string;
  currency: string;
  price: string;
  endTime: number;
  salt?: string;

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

  tokenStandard?: string;

  quantity?: string;
}

export interface CounterOfferIntentBody {
  sellerAddress:   string;
  nftContract:     string;
  tokenId:         string;
  currencyAddress: string;
  priceRaw:        string;
  durationSeconds: number;
  salt?:           string;
}

export interface FulfillOrderIntentBody {
  fulfiller: string;
  orderHash: string;

  tokenStandard?: string;

  quantity?: string;
}

export interface CancelOrderIntentBody {
  offerer: string;
  orderHash: string;

  tokenStandard?: string;
}

export interface MintIntentBody {

  owner: string;
  recipient: string;

  collectionId?: string;
  tokenUri?: string;

  royaltyBps?: number;

  tokenId?: string;
  amount?: string;
  value?: string;

  collectionContract?: string;
}

export interface CreateCollectionIntentBody {
  owner: string;
  name: string;
  symbol: string;
  baseUri: string;
  description?: string;

  image?: string;

  collectionContract?: string;

  service?: string;

  claimEndTimestamp?: number;

  eventType?: string;

  maxSupply?: string;

  conditions?: {
    startTime: number;
    endTime: number;
    price: string;
    paymentToken: string;
    maxQuantityPerWallet: string;
  };
}

export interface CreateTierIntentBody {

  owner: string;

  collection: string;

  service: string;
  maxSupply: string;

  startTime?: number;
  endTime?: number;
  royaltyBps: number;
  metadataUri: string;
}

export interface SubmitSignatureBody {
  signature: string[];
}

export interface CreateCoinIntentBody {

  owner: string;
  name: string;
  symbol: string;

  initialSupply: string;

  salt?: string;
}

export interface LaunchCoinIntentBody {

  owner: string;

  creatorCoin: string;

  quoteToken: string;

  initialHolders: string[];
  initialHoldersAmounts: string[];

  transferRestrictionDelay?: number;

  maxPercentageBuyLaunch?: number;

  quoteFundAmount?: string;
}

export interface CreateSponsorshipOfferIntentBody {
  author: string;
  nftContract: string;
  tokenId: string;
  minAmount: string;
  duration: number;
  paymentToken: string;
  licenseTermsUri: string;
  transferable: boolean;
  royaltyBps: number;
  specificSponsor?: string;
}

export interface SetSponsorshipOfferOpenIntentBody {
  author: string;
  offerId: string;
  open: boolean;
}

export interface PlaceSponsorshipBidIntentBody {
  sponsor: string;
  offerId: string;
  amount: string;
  paymentToken: string;
}

export interface RetractSponsorshipBidIntentBody {
  sponsor: string;
  offerId: string;
}

export interface AcceptSponsorshipBidIntentBody {
  author: string;
  offerId: string;
  sponsor: string;
}

export interface CreateSponsorshipProposalIntentBody {
  proposer: string;
  nftContract: string;
  tokenId: string;
  amount: string;
  duration: number;
  validUntil?: number;
  paymentToken: string;
  licenseTermsUri: string;
  transferable: boolean;
  royaltyBps: number;
}

export interface WithdrawSponsorshipProposalIntentBody {
  proposer: string;
  proposalId: string;
}

export interface AcceptSponsorshipProposalIntentBody {
  owner: string;
  proposalId: string;
}

export interface RejectSponsorshipProposalIntentBody {
  owner: string;
  proposalId: string;
}

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
