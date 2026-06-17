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
  test("usdcContract defaults to mainnet USDC", () => {
    expect(x402Config.usdcContract).toMatch(
      /^0x0?53c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8$/,
    );
  });
});
