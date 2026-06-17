import { describe, expect, test } from "bun:test";
import { CREDITS_PER_USDC, MDLN_TIERS, x402Config } from "./x402.js";

describe("x402 config", () => {
  test("CREDITS_PER_USDC is 100", () => {
    expect(CREDITS_PER_USDC).toBe(100);
  });
  test("MDLN tiers descending by threshold, 2.0x highest → 1.0x base", () => {
    expect(MDLN_TIERS[0]).toEqual({ minWholeTokens: 5000n, multiplier: 2.0 });
    expect(MDLN_TIERS.at(-1)).toEqual({ minWholeTokens: 0n, multiplier: 1.0 });
  });
  test("usdcContract defaults to Circle-native Starknet USDC", () => {
    expect(x402Config.usdcContract).toMatch(
      /^0x0?33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb$/,
    );
  });
});
