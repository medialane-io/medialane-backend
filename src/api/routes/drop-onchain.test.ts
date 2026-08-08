import { describe, expect, test } from "bun:test";
import { parseDropOnchainState } from "./drop-onchain.js";

describe("parseDropOnchainState", () => {
  test("formats conditions and casts bigint booleans", () => {
    const result = parseDropOnchainState({
      cond: { start_time: 1000n, end_time: 2000n, price: 5000000n, payment_token: 0xabcn, max_quantity_per_wallet: 3n },
      minted: 42n,
      max: 500n,
      allow: 1n,
      paused: 0n,
    });
    expect(result).toEqual({
      conditions: {
        maxSupply: "500",
        price: "5000000",
        paymentToken: "0xabc",
        startTime: 1000,
        endTime: 2000,
        maxPerWallet: "3",
      },
      totalMinted: 42,
      maxSupply: 500,
      allowlistEnabled: true,
      paused: false,
    });
  });

  test("accepts native booleans for allow/paused", () => {
    const result = parseDropOnchainState({
      cond: { start_time: 0n, end_time: 0n, price: 0n, payment_token: "0x0", max_quantity_per_wallet: 1n },
      minted: 0n,
      max: 100n,
      allow: false,
      paused: true,
    });
    expect(result.allowlistEnabled).toBe(false);
    expect(result.paused).toBe(true);
  });
});
