import { Hono } from "hono";
import { env } from "../../config/env.js";
import { createUsdPriceReader, type UsdPricesDeps } from "../../utils/usdPrices.js";

export type PricesDeps = UsdPricesDeps;

export function createPricesRoutes(deps: PricesDeps): Hono {
  const prices = new Hono();
  const read = createUsdPriceReader(deps);

  prices.get("/", async (c) => {
    if (!deps.apiKey) {
      return c.json({ error: "ALCHEMY_PRICES_KEY is not configured on the server" }, 500);
    }
    const usd = await read();
    if (!usd) return c.json({ error: "Prices upstream unreachable" }, 502);
    return c.json({ data: { usd } });
  });

  return prices;
}

export default createPricesRoutes({
  apiKey: env.ALCHEMY_PRICES_KEY,
  fetchImpl: fetch,
  now: () => Date.now(),
});
