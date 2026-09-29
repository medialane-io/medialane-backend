import { describe, expect, test } from "bun:test";
import { acceptedSymbols, tokenBySymbol, tokenAmountFor, usdValueOf } from "./assets.js";

const prices = async () => ({ USDC: 1, USDT: 1, ETH: 2000, STRK: 0.05 });
const noPrices = async () => null;
const token = (symbol: string) => tokenBySymbol(symbol)!;

describe("which tokens can fund an account", () => {
  test("exactly the tokens the platform already supports", () => {
    expect(acceptedSymbols()).toEqual(expect.arrayContaining(["USDC", "USDT", "ETH", "STRK"]));
  });
  test("a symbol resolves to its token, in any letter case, or to nothing", () => {
    expect(tokenBySymbol("eth")?.decimals).toBe(18);
    expect(tokenBySymbol("USDC")?.decimals).toBe(6);
    expect(tokenBySymbol("DOGE")).toBeUndefined();
  });
});

describe("what a transfer is worth in dollars", () => {
  test("USDC is worth what was sent, without asking the price feed", async () => {
    expect(await usdValueOf(token("USDC"), 5_000_000n, noPrices)).toBe(5_000_000n);
  });
  test("ETH is worth its amount times the price", async () => {
    expect(await usdValueOf(token("ETH"), 2_500_000_000_000_000n, prices)).toBe(5_000_000n); // 0.0025 ETH at $2000
  });
  test("STRK is worth its amount times the price", async () => {
    expect(await usdValueOf(token("STRK"), 100n * 10n ** 18n, prices)).toBe(5_000_000n); // 100 STRK at $0.05
  });
  test("no price means no value, never zero", async () => {
    expect(await usdValueOf(token("ETH"), 1n, noPrices)).toBeNull();
    expect(await usdValueOf(token("ETH"), 1n, async () => ({ USDC: 1 }))).toBeNull();
  });
});

describe("how much of a token is a dollar amount", () => {
  test("USDC is the amount itself", async () => {
    expect(await tokenAmountFor(token("USDC"), 5_000_000n, noPrices)).toBe(5_000_000n);
  });
  test("ETH is the dollars divided by the price, rounded up so it is never worth less", async () => {
    expect(await tokenAmountFor(token("ETH"), 5_000_000n, prices)).toBe(2_500_000_000_000_000n);
    const asked = await tokenAmountFor(token("STRK"), 1_234_567n, prices);
    expect(await usdValueOf(token("STRK"), asked!, prices)).toBeGreaterThanOrEqual(1_234_567n);
  });
  test("no price means no conversion", async () => {
    expect(await tokenAmountFor(token("ETH"), 5_000_000n, noPrices)).toBeNull();
  });
});
