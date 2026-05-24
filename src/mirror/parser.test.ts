// Decoder fixtures for the indexer's hot path. If these regress, the
// indexer silently corrupts state — these are the lowest-overhead tests
// with the highest leverage. Audit P1-1.
import { describe, expect, test } from "bun:test";
import { num } from "starknet";
import {
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  TRANSFER_SELECTOR,
  TRANSFER_SINGLE_SELECTOR,
} from "../config/constants.js";
import { parseEvent } from "./parser.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const MARKETPLACE = "0x00f8ccaae0bc811c79605974cc1dab769b9cea8877f033f8e3c17f30457caba6";
const COLLECTION = "0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2";
const ORDER_HASH = "0x7777777777777777777777777777777777777777777777777777777777777777";
const OFFERER = "0xabc";
const FULFILLER = "0xdef";
const TX_HASH = "0xfeedface";
const BLOCK_HASH = "0xb10c";

function rawEvent(overrides: Partial<RawStarknetEvent>): RawStarknetEvent {
  return {
    from_address: MARKETPLACE,
    keys: [],
    data: [],
    block_number: 12345,
    transaction_hash: TX_HASH,
    block_hash: BLOCK_HASH,
    ...overrides,
  };
}

describe("parseEvent — OrderCreated", () => {
  test("decodes ERC-721 marketplace OrderCreated", () => {
    const parsed = parseEvent(
      rawEvent({ keys: [num.toHex(ORDER_CREATED_SELECTOR), ORDER_HASH, OFFERER] }),
      0,
    );
    expect(parsed).toMatchObject({
      type: "OrderCreated",
      orderHash: ORDER_HASH,
      blockNumber: 12345n,
      logIndex: 0,
    });
    // offerer is normalized — 64-char padded
    expect((parsed as any).offerer).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000abc",
    );
    // txHash is normalized
    expect((parsed as any).txHash).toBe(
      "0x00000000000000000000000000000000000000000000000000000000feedface",
    );
  });
});

describe("parseEvent — OrderFulfilled", () => {
  test("decodes with offerer + fulfiller keys", () => {
    const parsed = parseEvent(
      rawEvent({ keys: [num.toHex(ORDER_FULFILLED_SELECTOR), ORDER_HASH, OFFERER, FULFILLER] }),
      1,
    );
    expect(parsed?.type).toBe("OrderFulfilled");
    expect((parsed as any).orderHash).toBe(ORDER_HASH);
    expect((parsed as any).fulfiller).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000def",
    );
  });
});

describe("parseEvent — ERC-721 Transfer", () => {
  test("decodes Cairo 1 shape: tokenId as u256 in keys[3..4]", () => {
    // tokenId = 42 → low=42, high=0
    const parsed = parseEvent(
      rawEvent({
        from_address: COLLECTION,
        keys: [num.toHex(TRANSFER_SELECTOR), OFFERER, FULFILLER, "0x2a", "0x0"],
      }),
      0,
    );
    expect(parsed?.type).toBe("Transfer");
    expect((parsed as any).tokenId).toBe("42");
    expect((parsed as any).contractAddress).toBe(
      "0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2",
    );
  });

  test("decodes Cairo 0 shape: tokenId as felt252 in keys[3]", () => {
    const parsed = parseEvent(
      rawEvent({
        from_address: COLLECTION,
        keys: [num.toHex(TRANSFER_SELECTOR), OFFERER, FULFILLER, "0xff"],
      }),
      0,
    );
    expect((parsed as any).tokenId).toBe("255");
  });
});

describe("parseEvent — ERC-1155 TransferSingle", () => {
  test("decodes operator + from + to + tokenId + amount", () => {
    // tokenId=7, amount=3
    const parsed = parseEvent(
      rawEvent({
        from_address: COLLECTION,
        keys: [num.toHex(TRANSFER_SINGLE_SELECTOR), "0xaaa", OFFERER, FULFILLER],
        data: ["0x7", "0x0", "0x3", "0x0"],
      }),
      0,
    );
    expect(parsed?.type).toBe("TransferSingle");
    expect((parsed as any).tokenId).toBe("7");
    expect((parsed as any).amount).toBe("3");
    expect((parsed as any).operator).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000aaa",
    );
  });
});

describe("parseEvent — unknown selector", () => {
  test("returns null for an unrecognized event", () => {
    expect(parseEvent(rawEvent({ keys: ["0xdeadbeef"] }), 0)).toBeNull();
  });
});
