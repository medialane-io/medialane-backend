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

type AlchemyHistoricalResponse = {
  data?: { value: string; timestamp: string }[];
};

export function nearestPrice(
  points: { value: string; timestamp: string }[] | undefined,
  at: Date,
): number | null {
  if (!points?.length) return null;
  let best: { value: number; distance: number } | null = null;
  for (const p of points) {
    const value = parseFloat(p.value);
    if (!Number.isFinite(value)) continue;
    const distance = Math.abs(new Date(p.timestamp).getTime() - at.getTime());
    if (!best || distance < best.distance) best = { value, distance };
  }
  return best ? best.value : null;
}

export function createHistoricalPriceReader(deps: UsdPricesDeps) {
  return async function priceAt(symbol: string, at: Date): Promise<number | null> {
    if (!deps.apiKey) return null;

    const window = 30 * 60 * 1000;
    const body = {
      symbol,
      startTime: new Date(at.getTime() - window).toISOString(),
      endTime: new Date(at.getTime() + window).toISOString(),
      interval: "5m",
    };

    try {
      const res = await deps.fetchImpl(
        `https://api.g.alchemy.com/prices/v1/${deps.apiKey}/tokens/historical`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as AlchemyHistoricalResponse;
      return nearestPrice(json.data, at);
    } catch (err) {
      log.error({ err, symbol }, "Historical price lookup failed");
      return null;
    }
  };
}

export const priceAt = createHistoricalPriceReader({
  apiKey: env.ALCHEMY_PRICES_KEY,
  fetchImpl: fetch,
  now: () => Date.now(),
});
