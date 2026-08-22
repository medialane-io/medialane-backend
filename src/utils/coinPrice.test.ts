import { describe, expect, test, beforeEach } from "bun:test";
import { getCoinPrices, clearCoinPriceCache, type CoinPriceDeps } from "./coinPrice.js";

const USDC_DECIMALS = 6;

function deps(
  quote: (args: { sellTokenAddress: string; sellAmount: bigint }) => unknown[],
  now = () => 1_000,
): CoinPriceDeps {
  return {
    getQuotes: (async (args: any) => quote(args)) as any,
    now,
    ttlMs: 60_000,
  };
}

const coin = (address: string, decimals = 18) => ({ contractAddress: address, decimals });

beforeEach(() => clearCoinPriceCache());

describe("getCoinPrices", () => {
  test("derives the price from how many coins a fixed USDC notional buys", async () => {

    const d = deps(() => [{ buyAmount: (400n * 10n ** 18n).toString() }]);
    const out = await getCoinPrices([coin("0xa")], d);
    expect(out["0xa"]).toEqual({ usdc: 10 / 400 });
  });

  test("quotes a meaningful USDC notional rather than one dust-sized coin", async () => {

    const seen: bigint[] = [];
    const d = deps((args) => {
      seen.push(args.sellAmount);
      return [{ buyAmount: (400n * 10n ** 18n).toString() }];
    });
    await getCoinPrices([coin("0xa", 18)], d);
    expect(seen).toEqual([10n * 10n ** BigInt(USDC_DECIMALS)]);
  });

  test("respects the coin's decimals when converting the bought amount", async () => {
    const d = deps(() => [{ buyAmount: (400n * 10n ** 6n).toString() }]);
    const out = await getCoinPrices([coin("0xa", 6)], d);
    expect(out["0xa"]).toEqual({ usdc: 10 / 400 });
  });

  test("returns null when no route exists rather than throwing", async () => {
    const d = deps(() => []);
    const out = await getCoinPrices([coin("0xa")], d);
    expect(out["0xa"]).toBeNull();
  });

  test("returns null when the upstream call fails", async () => {
    const d = deps(() => { throw new Error("avnu down"); });
    const out = await getCoinPrices([coin("0xa")], d);
    expect(out["0xa"]).toBeNull();
  });

  test("serves a cached price without calling upstream again", async () => {
    let calls = 0;
    const d = deps(() => { calls++; return [{ buyAmount: "2000000" }]; });
    await getCoinPrices([coin("0xa")], d);
    await getCoinPrices([coin("0xa")], d);
    expect(calls).toBe(1);
  });

  test("re-quotes once the TTL has passed", async () => {
    let calls = 0;
    let clock = 1_000;
    const d = { ...deps(() => { calls++; return [{ buyAmount: "2000000" }]; }), now: () => clock };
    await getCoinPrices([coin("0xa")], d);
    clock += 61_000;
    await getCoinPrices([coin("0xa")], d);
    expect(calls).toBe(2);
  });

  test("caches a null result too, so a dead pair is not re-quoted every request", async () => {
    let calls = 0;
    const d = deps(() => { calls++; return []; });
    await getCoinPrices([coin("0xa")], d);
    await getCoinPrices([coin("0xa")], d);
    expect(calls).toBe(1);
  });
});
