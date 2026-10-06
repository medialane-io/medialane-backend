import type { Chain, Order, Transfer } from "@prisma/client";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { isOrderSale } from "../utils/orderSale.js";

export const MAX_FEED_DEPTH = 1000;

export interface TransferActivityItem {
  type: "mint" | "transfer";
  chain: Chain;
  contractAddress: string;
  tokenId: string;
  from: string | null;
  to: string;
  blockNumber: string;
  amount: string;
  txHash: string;
  timestamp: Date;
}

export interface OrderActivityItem {
  type: "sale" | "offer" | "listing" | "cancelled";
  chain: Chain;
  orderHash: string;
  nftContract: string | null;
  nftTokenId: string | null;
  offerer: string;
  fulfiller: string | null;
  price: { raw: string | null; formatted: string | null; currency: string | null };
  tokenStandard: string;
  txHash: string;
  timestamp: Date;
}

export type ActivityFeedItem = TransferActivityItem | OrderActivityItem;

function isTransferActivityItem(item: ActivityFeedItem): item is TransferActivityItem {
  return item.type === "mint" || item.type === "transfer";
}

export function activityItemToken(item: ActivityFeedItem): { contract: string | null; tokenId: string | null } {
  if (isTransferActivityItem(item)) return { contract: item.contractAddress, tokenId: item.tokenId };
  return { contract: item.nftContract, tokenId: item.nftTokenId };
}

function transferType(fromAddress: string): "mint" | "transfer" {
  return fromAddress === ZERO_ADDRESS ? "mint" : "transfer";
}

function toTransferItem(t: Transfer): TransferActivityItem {
  return {
    type: transferType(t.fromAddress),
    chain: t.chain,
    contractAddress: t.contractAddress,
    tokenId: t.tokenId,
    from: t.fromAddress === ZERO_ADDRESS ? null : t.fromAddress,
    to: t.toAddress,
    blockNumber: t.blockNumber.toString(),
    amount: t.amount ?? "1",
    txHash: t.txHash,
    timestamp: t.createdAt,
  };
}

function toOrderItem(o: Order): OrderActivityItem {
  return {
    type: isOrderSale(o)
      ? "sale"
      : o.status === "ACTIVE" && o.offerItemType === "ERC20"
      ? "offer"
      : o.status === "ACTIVE"
      ? "listing"
      : "cancelled",
    chain: o.chain,
    orderHash: o.orderHash,
    nftContract: o.nftContract,
    nftTokenId: o.nftTokenId,
    offerer: o.offerer,
    fulfiller: o.fulfiller,
    price: { raw: o.priceRaw, formatted: o.priceFormatted, currency: o.currencySymbol },
    tokenStandard: o.offerItemType === "ERC20" ? o.considerationItemType : o.offerItemType,
    txHash: o.createdTxHash,
    timestamp: o.updatedAt,
  };
}

export function mergeFeed(
  transfers: Transfer[],
  orders: Order[],
  opts: { skip: number; limit: number; hiddenTokenSet: Set<string> },
): ActivityFeedItem[] {
  const saleTxHashes = new Set(
    orders
      .filter((o) => isOrderSale(o) && (o.fulfilledTxHash || o.createdTxHash))
      .map((o) => (o.fulfilledTxHash ?? o.createdTxHash) as string)
  );

  return [
    ...transfers.filter((t) => !saleTxHashes.has(t.txHash)).map(toTransferItem),
    ...orders.map(toOrderItem),
  ]
    .filter((item) => {
      if (opts.hiddenTokenSet.size === 0) return true;
      const { contract, tokenId } = activityItemToken(item);
      return !opts.hiddenTokenSet.has(`${contract}:${tokenId}`);
    })
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(opts.skip, opts.skip + opts.limit);
}
