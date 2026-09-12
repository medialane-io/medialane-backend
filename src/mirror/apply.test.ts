import { describe, expect, test } from "bun:test";
import { isMarketplace1155Event, deduplicateTransfers } from "./apply.js";
import { STARKNET_MARKETPLACE_1155_CONTRACT } from "../config/constants.js";
import type { RawStarknetEvent } from "../types/starknet.js";

function rawEvent(from: string): RawStarknetEvent {
  return {
    from_address: from,
    keys: ["0x1"],
    data: [],
    block_number: 1,
    transaction_hash: "0xtx",
  } as unknown as RawStarknetEvent;
}

describe("an event is classified by where it came from, not by who fetched it", () => {
  test("the 1155 marketplace is recognised from the event's own address", () => {
    expect(isMarketplace1155Event(rawEvent(STARKNET_MARKETPLACE_1155_CONTRACT))).toBe(true);
  });

  test("padding on the address does not change the answer", () => {
    const padded = "0x" + STARKNET_MARKETPLACE_1155_CONTRACT.replace(/^0x0*/, "").padStart(64, "0");
    expect(isMarketplace1155Event(rawEvent(padded))).toBe(true);
  });

  test("any other contract is not the 1155 marketplace", () => {
    expect(isMarketplace1155Event(rawEvent("0x1234"))).toBe(false);
  });

  test("an event with no address belongs to nobody", () => {
    expect(isMarketplace1155Event({ keys: [], data: [] } as unknown as RawStarknetEvent)).toBe(false);
  });
});

describe("a transfer reported twice is applied once", () => {
  const transfer = {
    type: "Transfer",
    txHash: "0xa",
    contractAddress: "0xc",
    tokenId: "1",
    from: "0x0",
    to: "0xb",
  };
  const single = { ...transfer, type: "TransferSingle" };

  test("the erc721 shape is dropped when the erc1155 shape covers it", () => {
    const out = deduplicateTransfers([transfer, single] as never);
    expect(out.map((e) => e.type)).toEqual(["TransferSingle"]);
  });

  test("a transfer with no matching single survives", () => {
    const out = deduplicateTransfers([transfer] as never);
    expect(out.map((e) => e.type)).toEqual(["Transfer"]);
  });

  test("a different token is not treated as the same transfer", () => {
    const other = { ...single, tokenId: "2" };
    const out = deduplicateTransfers([transfer, other] as never);
    expect(out.length).toBe(2);
  });

  test("events that are not transfers pass through untouched", () => {
    const order = { type: "OrderCreated", orderHash: "0x1" };
    expect(deduplicateTransfers([order] as never)).toEqual([order] as never);
  });
});
