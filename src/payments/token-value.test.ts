import { test, expect } from "bun:test";
import { usdcEquivalentAtomic, tokenByAddress, acceptedTokens } from "./token-value.js";

const USDC = acceptedTokens().find((t) => t.symbol === "USDC")!;
const ETH = acceptedTokens().find((t) => t.symbol === "ETH")!;
const WBTC = acceptedTokens().find((t) => t.symbol === "WBTC")!;

test("a dollar of USDC values as it always did", () => {
  expect(usdcEquivalentAtomic(1_000_000n, 6, 1)).toBe(1_000_000n);
});

test("ten dollars of USDC is worth ten dollars of credits", () => {
  const value = usdcEquivalentAtomic(10_000_000n, 6, 1)!;
  expect(Number(value / 10_000n)).toBe(1000);
});

test("one ETH values at its price", () => {
  const oneEth = 10n ** 18n;
  expect(usdcEquivalentAtomic(oneEth, ETH.decimals, 3000)).toBe(3_000_000_000n);
});

test("a fraction of an ETH values proportionally", () => {
  const tenth = 10n ** 17n;
  expect(usdcEquivalentAtomic(tenth, ETH.decimals, 3000)).toBe(300_000_000n);
});

test("WBTC's eight decimals are handled", () => {
  const oneBtc = 10n ** 8n;
  expect(usdcEquivalentAtomic(oneBtc, WBTC.decimals, 60000)).toBe(60_000_000_000n);
});

test("a depegged stablecoin credits at what it is worth", () => {
  expect(usdcEquivalentAtomic(1_000_000n, 6, 0.98)).toBe(980_000n);
});

test("a missing or nonsense price credits nothing rather than guessing", () => {
  expect(usdcEquivalentAtomic(1_000_000n, 6, 0)).toBeNull();
  expect(usdcEquivalentAtomic(1_000_000n, 6, -1)).toBeNull();
  expect(usdcEquivalentAtomic(1_000_000n, 6, NaN)).toBeNull();
});

test("dust rounds down rather than up", () => {
  expect(usdcEquivalentAtomic(1n, 18, 3000)).toBe(0n);
});

test("every accepted token is recognised by its address", () => {
  for (const token of acceptedTokens()) {
    expect(tokenByAddress(token.address)?.symbol).toBe(token.symbol);
  }
});

test("an unpadded address still matches", () => {
  const unpadded = "0x" + USDC.address.replace(/^0x0*/, "");
  expect(tokenByAddress(unpadded)?.symbol).toBe("USDC");
});

test("an unknown token is not accepted", () => {
  expect(tokenByAddress("0x1234")).toBeUndefined();
  expect(tokenByAddress("not-an-address")).toBeUndefined();
});

test("the accepted set is the five we price", () => {
  expect(acceptedTokens().map((t) => t.symbol).sort()).toEqual(["ETH", "STRK", "USDC", "USDT", "WBTC"]);
});
