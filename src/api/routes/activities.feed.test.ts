import { describe, expect, test } from "bun:test";
import type { Order, Transfer } from "@prisma/client";
import { mergeFeed, type ActivityFeedItem } from "./activities.feed.js";

const at = (s: number) => new Date(s * 1000);

const transfer = (id: string, s: number, txHash = `0xt${id}`) =>
  ({
    chain: "STARKNET", contractAddress: "0xc", tokenId: id, fromAddress: "0x1", toAddress: "0x2",
    amount: "1", blockNumber: BigInt(s), txHash, logIndex: 0, createdAt: at(s),
  }) as unknown as Transfer;

const order = (id: string, s: number, over: Partial<Order> = {}) =>
  ({
    chain: "STARKNET", orderHash: `0xo${id}`, nftContract: "0xc", nftTokenId: id, offerer: "0x1",
    fulfiller: null, status: "CANCELLED", offerItemType: "ERC721", considerationItemType: "ERC20",
    remainingAmount: null, priceRaw: null, priceFormatted: null, currencySymbol: null,
    createdTxHash: `0xc${id}`, fulfilledTxHash: null, updatedAt: at(s), ...over,
  }) as unknown as Order;

const transfers = [transfer("t10", 10), transfer("t8", 8), transfer("t6", 6), transfer("t4", 4)];
const orders = [order("o9", 9), order("o7", 7), order("o5", 5), order("o3", 3)];
const ids = (feed: ActivityFeedItem[]) => feed.map((i) => ("tokenId" in i ? i.tokenId : i.nftTokenId));
const none = new Set<string>();

describe("mergeFeed", () => {
  test("page two continues exactly where page one stopped", () => {
    expect(ids(mergeFeed(transfers, orders, { skip: 0, limit: 3, hiddenTokenSet: none }))).toEqual(["t10", "o9", "t8"]);
    expect(ids(mergeFeed(transfers, orders, { skip: 3, limit: 3, hiddenTokenSet: none }))).toEqual(["o7", "t6", "o5"]);
  });

  test("hidden tokens are dropped before the page is cut", () => {
    const hidden = new Set(["0xc:t10"]);
    expect(ids(mergeFeed(transfers, orders, { skip: 0, limit: 2, hiddenTokenSet: hidden }))).toEqual(["o9", "t8"]);
  });

  test("a transfer that settled a sale is shown once, as the sale", () => {
    const sale = order("s", 20, { status: "FULFILLED", fulfilledTxHash: "0xsale" } as Partial<Order>);
    const feed = mergeFeed([transfer("s", 20, "0xsale")], [sale], { skip: 0, limit: 10, hiddenTokenSet: none });
    expect(feed.map((i) => i.type)).toEqual(["sale"]);
  });
});
