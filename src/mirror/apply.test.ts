import { describe, expect, test } from "bun:test";
import { isMarketplace1155Event, deduplicateTransfers, applyEvents } from "./apply.js";
import { num } from "starknet";
import type { Prisma } from "@prisma/client";
import { STARKNET_MARKETPLACE_1155_CONTRACT, TRANSFER_SELECTOR, ZERO_ADDRESS } from "../config/constants.js";
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

test("a batch of transfers checks each collection once", async () => {
  const upserts: string[] = [];
  const tx = {
    collection: {
      upsert: async (a: { where: { chain_contractAddress: { contractAddress: string } } }) => {
        upserts.push(a.where.chain_contractAddress.contractAddress);
        return {};
      },
    },
    token: { upsert: async () => ({}) },
    transfer: { createMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
  } as unknown as Prisma.TransactionClient;
  const mint = (tokenId: string, i: number) =>
    ({
      from_address: "0xc0ffee",
      keys: [num.toHex(TRANSFER_SELECTOR), ZERO_ADDRESS, "0xa11ce", tokenId, "0x0"],
      data: [],
      block_number: 1,
      transaction_hash: "0x123abc",
      event_index: i,
    }) as unknown as RawStarknetEvent;

  await applyEvents([mint("0x1", 0), mint("0x2", 1), mint("0x3", 2)], tx, "STARKNET");

  expect(upserts).toHaveLength(1);
});
