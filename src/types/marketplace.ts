// --- Medialane Simplified Marketplace Types (Matching On-Chain ABI) ---

export interface OfferItem {
  item_type: string;
  token: string;
  identifier_or_criteria: string;
  start_amount: string;
  end_amount: string;
}

export interface ConsiderationItem extends OfferItem {
  recipient: string;
}

export interface OrderParameters {
  offerer: string;
  offer: OfferItem;
  consideration: ConsiderationItem;
  start_time: string;
  end_time: string;
  salt: string;
  nonce: string;
}

export type Fulfillment = {
  order_hash: string;
  fulfiller: string;
  nonce: string;
};

export type Cancelation = {
  order_hash: string;
  offerer: string;
  nonce: string;
};

export interface Order {
  parameters: OrderParameters;
  signature: string[];
}

// --- Parsed on-chain event shapes ---

export interface ParsedOrderCreated {
  type: "OrderCreated";
  orderHash: string;
  offerer: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export interface ParsedOrderFulfilled {
  type: "OrderFulfilled";
  orderHash: string;
  offerer: string;
  fulfiller: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  /** ERC-1155 only - units bought in this fill. Defaults to "1" for ERC-721. */
  quantity?: string;
  /** ERC-1155 only - units still available after this fill. "0" means the order is fully fulfilled. */
  remainingAmount?: string;
}

export interface ParsedOrderCancelled {
  type: "OrderCancelled";
  orderHash: string;
  offerer: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export interface ParsedTransfer {
  type: "Transfer";
  contractAddress: string;
  from: string;
  to: string;
  tokenId: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export interface ParsedTransferSingle {
  type: "TransferSingle";
  contractAddress: string;
  operator: string;
  from: string;
  to: string;
  tokenId: string;
  amount: string; // decimal string
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export interface ParsedTransferBatch {
  type: "TransferBatch";
  contractAddress: string;
  operator: string;
  from: string;
  to: string;
  transfers: Array<{ tokenId: string; amount: string }>;
  blockNumber: bigint;
  txHash: string;
  logIndex: number; // base logIndex — individual Transfer rows use logIndex * 10000 + itemIndex
}

export interface ParsedCollectionCreated {
  type: "CollectionCreated";
  collectionId: string; // decimal string
  owner: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export type ParsedEvent =
  | ParsedOrderCreated
  | ParsedOrderFulfilled
  | ParsedOrderCancelled
  | ParsedTransfer
  | ParsedTransferSingle
  | ParsedTransferBatch
  | ParsedCollectionCreated;

// --- Order details from RPC ---

export interface OnChainOrderDetails {
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
  /** ERC-1155 only - units still available. Absent for ERC-721 (always single-fill). */
  remainingAmount?: string;
  status: "active" | "fulfilled" | "cancelled";
  fulfiller: string | null;
}
