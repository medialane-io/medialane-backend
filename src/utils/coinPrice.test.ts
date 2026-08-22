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
  test("converts the quoted USDC buyAmount into a decimal price", async () => {
    const d = deps(() => [{ buyAmount: (25n * 10n ** BigInt(USDC_DECIMALS)).toString() }]);
    const out = await getCoinPrices([coin("0xa")], d);
    expect(out["0xa"]).toEqual({ usdc: 25 });
  });

  test("sells exactly one whole coin, respecting its decimals", async () => {
    const seen: bigint[] = [];
    const d = deps((args) => {
      seen.push(args.sellAmount);
      return [{ buyAmount: "1000000" }];
    });
    await getCoinPrices([coin("0xa", 18), coin("0xb", 6)], d);
    expect(seen).toContain(10n ** 18n);
    expect(seen).toContain(10n ** 6n);
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
