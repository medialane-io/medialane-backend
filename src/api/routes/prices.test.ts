import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createPricesRoutes, type PricesDeps } from "./prices.js";

const ALCHEMY_BODY = {
  data: [
    { symbol: "STRK", prices: [{ currency: "usd", value: "0.45", lastUpdatedAt: "2026-08-03T00:00:00Z" }], error: null },
    { symbol: "ETH", prices: [{ currency: "usd", value: "3000.12", lastUpdatedAt: "2026-08-03T00:00:00Z" }], error: null },
    { symbol: "USDC", prices: [{ currency: "usd", value: "1.00", lastUpdatedAt: "2026-08-03T00:00:00Z" }], error: null },
    { symbol: "WBTC", prices: [{ currency: "usd", value: "60000.00", lastUpdatedAt: "2026-08-03T00:00:00Z" }], error: null },
  ],
};

function makeApp(deps: Partial<PricesDeps> = {}) {
  const app = new Hono();
  app.route("/v1/prices", createPricesRoutes({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify(ALCHEMY_BODY), { status: 200 }),
    now: () => 0,
    ...deps,
  }));
  return app;
}

test("returns usd prices for the four tracked symbols", async () => {
  const app = makeApp();
  const res = await app.request("/v1/prices");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { usd: Record<string, number> } };
  expect(body.data.usd).toEqual({ STRK: 0.45, ETH: 3000.12, USDC: 1, WBTC: 60000 });
});

test("500s with no upstream call when the key is unconfigured", async () => {
  let called = false;
  const app = makeApp({ apiKey: "", fetchImpl: async () => { called = true; return new Response("{}"); } });
  const res = await app.request("/v1/prices");
  expect(res.status).toBe(500);
  expect(called).toBe(false);
});

test("a second request within the 30s TTL hits the cache, not the upstream", async () => {
  let calls = 0;
  let clock = 0;
  const app = makeApp({
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(ALCHEMY_BODY), { status: 200 }); },
    now: () => clock,
  });
  await app.request("/v1/prices");
  clock = 10_000; // +10s, inside the 30s TTL
  await app.request("/v1/prices");
  expect(calls).toBe(1);
});

test("a request after the 30s TTL refetches from upstream", async () => {
  let calls = 0;
  let clock = 0;
  const app = makeApp({
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(ALCHEMY_BODY), { status: 200 }); },
    now: () => clock,
  });
  await app.request("/v1/prices");
  clock = 31_000; // past the 30s TTL
  await app.request("/v1/prices");
  expect(calls).toBe(2);
});

test("upstream failure returns 502 without caching a bad result", async () => {
  const app = makeApp({ fetchImpl: async () => new Response("boom", { status: 500 }) });
  const res = await app.request("/v1/prices");
  expect(res.status).toBe(502);
});
