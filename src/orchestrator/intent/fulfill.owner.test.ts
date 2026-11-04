import { describe, expect, mock, test } from "bun:test";

let order: Record<string, unknown> | null = null;
let fact: Record<string, unknown> = {};
const reads: unknown[][] = [];

mock.module("../../db/client.js", () => ({
  default: { order: { findUnique: async () => order } },
}));
mock.module("../../chainRead/ownership.js", () => ({
  readOwnership: async (keys: unknown[]) => {
    reads.push(keys);
    return [fact];
  },
}));

const { buildFulfillOrderIntent } = await import("./marketplace.js");
const { IntentRefusal } = await import("./refusal.js");

const ALICE = "0x" + "a".repeat(63) + "1";
const NO_LONGER = "This listing is no longer available because the seller no longer owns this item.";
const LACKS = "The seller no longer has enough of this item to complete this purchase.";

const listing = {
  offerItemType: "ERC721",
  considerationItemType: "ERC20",
  considerationToken: "0xusdc",
  considerationStartAmount: "1000",
  nftContract: "0xnft",
  nftTokenId: "5",
  offerer: ALICE,
};
const body = (extra: object = {}) => ({ fulfiller: "0xbob", orderHash: "0xabc", ...extra }) as never;

describe("buildFulfillOrderIntent seller ownership", () => {
  test("refuses when another account now holds the token", async () => {
    order = listing;
    fact = { standard: "ERC721", owner: "0xbob" };
    reads.length = 0;
    const err = await buildFulfillOrderIntent(body()).catch((e) => e);
    expect(err).toBeInstanceOf(IntentRefusal);
    expect(err.reason).toBe(NO_LONGER);
    expect(reads[0]).toEqual([{ standard: "ERC721", contractAddress: "0xnft", tokenId: "5" }]);
  });

  test("refuses when nobody holds the token", async () => {
    order = listing;
    fact = { standard: "ERC721", owner: null };
    const err = await buildFulfillOrderIntent(body()).catch((e) => e);
    expect(err.reason).toBe(NO_LONGER);
  });

  test("builds the purchase while the seller still holds the token", async () => {
    order = listing;
    fact = { standard: "ERC721", owner: ALICE };
    const { calls } = await buildFulfillOrderIntent(body());
    expect(calls.map((c) => c.entrypoint)).toContain("fulfill_order");
  });

  test("ERC-1155: refuses when the seller holds none", async () => {
    order = { ...listing, offerItemType: "ERC1155" };
    fact = { standard: "ERC1155", amount: 0n };
    const err = await buildFulfillOrderIntent(body({ quantity: "2" })).catch((e) => e);
    expect(err.reason).toBe(NO_LONGER);
  });

  test("ERC-1155: refuses when the seller holds fewer than the quantity bought", async () => {
    order = { ...listing, offerItemType: "ERC1155" };
    fact = { standard: "ERC1155", amount: 1n };
    reads.length = 0;
    const err = await buildFulfillOrderIntent(body({ quantity: "2" })).catch((e) => e);
    expect(err.reason).toBe(LACKS);
    expect(reads[0]).toEqual([{ standard: "ERC1155", contractAddress: "0xnft", tokenId: "5", owner: ALICE }]);
  });

  test("ERC-1155: builds the purchase when the seller holds enough", async () => {
    order = { ...listing, offerItemType: "ERC1155" };
    fact = { standard: "ERC1155", amount: 2n };
    const { calls } = await buildFulfillOrderIntent(body({ quantity: "2" }));
    expect(calls.map((c) => c.entrypoint)).toContain("fulfill_order");
  });

  test("does not read ownership for an offer", async () => {
    order = {
      ...listing,
      offerItemType: "ERC20",
      considerationItemType: "ERC721",
      considerationIdentifier: "5",
      considerationToken: "0xnft",
    };
    reads.length = 0;
    await buildFulfillOrderIntent(body());
    expect(reads).toHaveLength(0);
  });
});
