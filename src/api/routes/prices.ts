import { Hono } from "hono";
import { env } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:prices");

const SYMBOLS = ["STRK", "ETH", "USDC", "WBTC"] as const;
type Symbol = (typeof SYMBOLS)[number];
type UsdPrices = Partial<Record<Symbol, number>>;

type AlchemyPricesResponse = {
  data: {
    symbol: string;
    prices: { currency: string; value: string; lastUpdatedAt: string }[];
    error: string | null;
  }[];
};

const CACHE_TTL_MS = 30_000;

export interface PricesDeps {
  /** Bare Alchemy API key (Prices API enabled). Empty = unconfigured. */
  apiKey: string;
  /** Injectable for tests — defaults to the real `fetch`. Narrower than `typeof fetch` (no `preconnect`) so a plain async mock satisfies it. */
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Injectable clock (ms) — defaults to `Date.now`. */
  now: () => number;
}

export function createPricesRoutes(deps: PricesDeps): Hono {
  const prices = new Hono();

  // One upstream fetch per `CACHE_TTL_MS` regardless of request volume —
  // bursts of page renders (each mounting `useUsdPrices`) must not multiply
  // Alchemy calls or credit debits. Scoped to this route instance (not
  // module-level) so the one real instance below is a process-wide singleton
  // in prod, while tests creating their own instance get an isolated cache.
  let cache: { usd: UsdPrices; fetchedAt: number } | null = null;

  prices.get("/", async (c) => {
    if (!deps.apiKey) {
      return c.json({ error: "ALCHEMY_PRICES_KEY is not configured on the server" }, 500);
    }

    const now = deps.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return c.json({ data: { usd: cache.usd } });
    }

    const url = new URL(`https://api.g.alchemy.com/prices/v1/${deps.apiKey}/tokens/by-symbol`);
    for (const s of SYMBOLS) url.searchParams.append("symbols", s);

    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(url, { cache: "no-store" });
    } catch (err) {
      log.error({ err }, "Prices upstream unreachable");
      return c.json({ error: "Prices upstream unreachable" }, 502);
    }

    if (!upstream.ok) {
      log.error({ status: upstream.status }, "Prices upstream returned a non-OK status");
      return c.json({ error: `Prices upstream returned ${upstream.status}` }, 502);
    }

    const body = (await upstream.json()) as AlchemyPricesResponse;
    const usd: UsdPrices = {};
    for (const entry of body.data) {
      if (entry.error) continue;
      const price = entry.prices.find((p) => p.currency.toLowerCase() === "usd");
      if (!price) continue;
      usd[entry.symbol as Symbol] = parseFloat(price.value);
    }

    cache = { usd, fetchedAt: now };
    return c.json({ data: { usd } });
  });

  return prices;
}

export default createPricesRoutes({
  apiKey: env.ALCHEMY_PRICES_KEY,
  fetchImpl: fetch,
  now: () => Date.now(),
});
