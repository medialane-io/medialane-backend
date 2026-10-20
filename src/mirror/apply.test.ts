import { describe, expect, test } from "bun:test";
import { isMarketplace1155Event, deduplicateTransfers, prepareOwnership } from "./apply.js";
import { STARKNET_MARKETPLACE_1155_CONTRACT, TRANSFER_SELECTOR } from "../config/constants.js";
import type { OwnershipKey } from "../chainRead/ownership.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { normalizeAddress } from "../utils/starknet.js";

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

describe("ownership is read before a batch is written", () => {
  const contract = "0x0c0ffee";
  const erc721Transfer = {
    from_address: contract,
    keys: [TRANSFER_SELECTOR, "0xa", "0xb", "0x7", "0x0"],
    data: [],
    block_number: 1,
    transaction_hash: "0x1",
  } as unknown as RawStarknetEvent;

  test("ownership is read for the transfers in the raw events", async () => {
    const asked: OwnershipKey[][] = [];
    await prepareOwnership([erc721Transfer], async (keys) => {
      asked.push(keys);
      return [];
    });
    expect(asked).toEqual([[{ standard: "ERC721", contractAddress: normalizeAddress("STARKNET", contract), tokenId: "7" }]]);
  });

  test("a failed ownership read fails before anything is written", async () => {
    await expect(prepareOwnership([erc721Transfer], async () => { throw new Error("fetch failed"); })).rejects.toThrow("fetch failed");
  });

  test("a batch with no transfers reads nothing", async () => {
    const asked: OwnershipKey[][] = [];
    const unrelated = { ...erc721Transfer, keys: ["0x1"] } as RawStarknetEvent;
    await prepareOwnership([unrelated], async (keys) => {
      asked.push(keys);
      return [];
    });
    expect(asked).toEqual([[]]);
  });
});
