import { describe, expect, test } from "bun:test";
import { assertOrderPopulated } from "./orderGuards.js";
import type { OnChainOrderDetails } from "../../types/marketplace.js";

// Guards against the 2026-06-08 "zombie listing" incident: a lagging RPC node
// returns an all-zero order from get_order_details with no error, which used to
// be persisted as an ACTIVE order with null nftContract/nftTokenId.

const populated: OnChainOrderDetails = {
  offerer: "0x07af58a635dd8f8991b984ca02a8837be6c2ee99e3bf27e1886af560b6d8e07e",
  offerItemType: "ERC1155",
  offerToken: "0x044935877f952ca9bd60b66b5277f6d939d4602bbf6f70a545c99f5069971036",
  offerIdentifier: "1780952905945426167",
  offerAmount: "1",
  considerationItemType: "ERC20",
  considerationToken: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  considerationIdentifier: "0",
  considerationAmount: "1000000000000000000",
  considerationRecipient: "0x07af58a635dd8f8991b984ca02a8837be6c2ee99e3bf27e1886af560b6d8e07e",
  royaltyMaxBps: "0",
  startTime: 0n,
  endTime: 0n,
  status: "active",
};

const emptyZero: OnChainOrderDetails = {
  ...populated,
  offerer: "0x0000000000000000000000000000000000000000000000000000000000000000",
  offerItemType: "",
  offerToken: "0x0000000000000000000000000000000000000000000000000000000000000000",
  offerIdentifier: "0",
  offerAmount: "0",
  considerationItemType: "",
  considerationToken: "0x0000000000000000000000000000000000000000000000000000000000000000",
  considerationAmount: "0",
};

describe("assertOrderPopulated", () => {
  test("throws on an all-zero (lagging-node) order", () => {
    expect(() => assertOrderPopulated(emptyZero, "0x7c33")).toThrow(/empty order/);
  });

  test("throws when only the offerer is zero", () => {
    expect(() => assertOrderPopulated({ ...populated, offerer: "0x0" }, "0x7c33")).toThrow();
  });

  test("throws when only the item type is empty", () => {
    expect(() => assertOrderPopulated({ ...populated, offerItemType: "" }, "0x7c33")).toThrow();
  });

  test("passes a fully populated order", () => {
    expect(() => assertOrderPopulated(populated, "0x7c33")).not.toThrow();
  });
});
