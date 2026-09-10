import { env } from "../config/env.js";
import { createLogger } from "./logger.js";

const log = createLogger("usd-prices");

export const PRICED_SYMBOLS = ["STRK", "ETH", "USDC", "USDT", "WBTC"] as const;
export type PricedSymbol = (typeof PRICED_SYMBOLS)[number];
export type UsdPrices = Partial<Record<PricedSymbol, number>>;

const CACHE_TTL_MS = 30_000;

type AlchemyPricesResponse = {
  data: {
    symbol: string;
    prices: { currency: string; value: string; lastUpdatedAt: string }[];
    error: string | null;
  }[];
};

export interface UsdPricesDeps {
  apiKey: string;
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

export function createUsdPriceReader(deps: UsdPricesDeps) {
  let cache: { usd: UsdPrices; fetchedAt: number } | null = null;

  return async function readUsdPrices(): Promise<UsdPrices | null> {
    if (!deps.apiKey) return null;

    const now = deps.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.usd;

    const url = new URL(`https://api.g.alchemy.com/prices/v1/${deps.apiKey}/tokens/by-symbol`);
    for (const s of PRICED_SYMBOLS) url.searchParams.append("symbols", s);

    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(url, { cache: "no-store" });
    } catch (err) {
      log.error({ err }, "Prices upstream unreachable");
      return null;
    }

    if (!upstream.ok) {
      log.error({ status: upstream.status }, "Prices upstream returned a non-OK status");
      return null;
    }

    const body = (await upstream.json()) as AlchemyPricesResponse;
    const usd: UsdPrices = {};
    for (const entry of body.data) {
      if (entry.error) continue;
      const price = entry.prices.find((p) => p.currency.toLowerCase() === "usd");
      if (!price) continue;
      usd[entry.symbol as PricedSymbol] = parseFloat(price.value);
    }

    cache = { usd, fetchedAt: now };
    return usd;
  };
}

export const readUsdPrices = createUsdPriceReader({
  apiKey: env.ALCHEMY_PRICES_KEY,
  fetchImpl: fetch,
  now: () => Date.now(),
});
