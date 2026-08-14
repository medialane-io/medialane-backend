

export interface OfferItem {
  item_type: string;
  token: string;
  identifier_or_criteria: string;
  amount: string;
}

export interface ConsiderationItem extends OfferItem {
  recipient: string;
}

export interface OrderParameters {
  offerer: string;
  marketplace: string;
  offer: OfferItem;
  consideration: ConsiderationItem;
  royalty_max_bps: string;
  start_time: string;
  end_time: string;
  salt: string;
  counter: string;
}

export type Cancelation = {
  order_hash: string;
  offerer: string;
};

export interface Order {
  parameters: OrderParameters;
  signature: string[];
}

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

  quantity?: string;

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

export interface ParsedCounterIncremented {
  type: "CounterIncremented";
  offerer: string;
  newCounter: string;
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
  amount: string;
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
  logIndex: number;
}

export interface ParsedCollectionCreated {
  type: "CollectionCreated";
  collectionId: string;
  owner: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export type ParsedEvent =
  | ParsedOrderCreated
  | ParsedOrderFulfilled
  | ParsedOrderCancelled
  | ParsedCounterIncremented
  | ParsedTransfer
  | ParsedTransferSingle
  | ParsedTransferBatch
  | ParsedCollectionCreated;

export interface OnChainOrderDetails {
  offerer: string;
  offerItemType: string;
  offerToken: string;
  offerIdentifier: string;
  offerAmount: string;
  considerationItemType: string;
  considerationToken: string;
  considerationIdentifier: string;
  considerationAmount: string;
  considerationRecipient: string;
  royaltyMaxBps: string;
  startTime: bigint;
  endTime: bigint;

  remainingAmount?: string;
  status: "active" | "fulfilled" | "cancelled";
}
