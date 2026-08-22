import { test, expect } from "bun:test";
import { parseClaimConditionsUpdated, buildDropConditionsSeed } from "./dropFactory.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

function event(overrides: Partial<RawStarknetEvent> = {}): RawStarknetEvent {
  return {
    from_address: "0x0225c3ae09506b8d97adc39649ca740dad5aac195b7f5f0441cc1852947acaea",
    keys: ["0xselector", "0x1", "0x0"],
    data: ["0x64", "0xc8", "0x3e8", "0x0", "0x5", "0x0", "0x12c"],
    block_number: 100,
    transaction_hash: "0xtx",
    ...overrides,
  } as RawStarknetEvent;
}

test("parses start time, end time, price and per-wallet cap from the payload", () => {
  const parsed = parseClaimConditionsUpdated(event());
  expect(parsed).not.toBeNull();
  expect(parsed!.startTime).toBe(100n);
  expect(parsed!.endTime).toBe(200n);
  expect(parsed!.price).toBe("1000");
  expect(parsed!.maxPerWallet).toBe("5");
});

test("normalizes the emitting collection address", () => {
  const parsed = parseClaimConditionsUpdated(event({ from_address: "0x225C3AE" }));
  expect(parsed!.collectionAddress.startsWith("0x")).toBe(true);
  expect(parsed!.collectionAddress).toBe(parsed!.collectionAddress.toLowerCase());
});

test("reassembles a u256 price that spans two felts", () => {
  const parsed = parseClaimConditionsUpdated(
    event({ data: ["0x0", "0x0", "0x0", "0x1", "0x1", "0x0", "0x0"] }),
  );
  expect(parsed!.price).toBe((1n << 128n).toString());
});

test("returns null on a short payload instead of throwing", () => {
  expect(parseClaimConditionsUpdated(event({ data: ["0x1"] }))).toBeNull();
  expect(parseClaimConditionsUpdated(event({ data: [] }))).toBeNull();
});

test("builds a seed row from a chain read", () => {
  const seed = buildDropConditionsSeed("0xdrop1", {
    maxSupply: 500n,
    startTime: 100n,
    endTime: 200n,
    price: 1000n,
    paymentToken: "0xusdc",
    maxPerWallet: 5n,
  });
  expect(seed.collectionAddress).toBe("0xdrop1");
  expect(seed.maxSupply).toBe("500");
  expect(seed.price).toBe("1000");
  expect(seed.paymentToken).toBe("0xusdc");
  expect(seed.maxPerWallet).toBe("5");
  expect(seed.startTime).toBe(100n);
});

test("a zero payment token is preserved rather than normalized away", () => {
  const seed = buildDropConditionsSeed("0xdrop1", {
    maxSupply: 1n, startTime: 0n, endTime: 0n, price: 0n, paymentToken: "0x0", maxPerWallet: 0n,
  });
  expect(seed.paymentToken).toBe("0x0");
});
