// --- Medialane Simplified Marketplace Types (Matching On-Chain ABI) ---

/**
 * ItemType denotes the type of item being transferred.
 * 0: Native (ETH/STRK)
 * 1: ERC20
 * 2: ERC721
 * 3: ERC1155
 */
export enum ItemType {
  NATIVE = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
}

export interface OfferItem {
  item_type: ItemType;
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

export type ParsedEvent =
  | ParsedOrderCreated
  | ParsedOrderFulfilled
  | ParsedOrderCancelled
  | ParsedTransfer;

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
  status: "active" | "fulfilled" | "cancelled";
  fulfiller: string | null;
}
