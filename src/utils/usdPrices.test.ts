import { test, expect } from "bun:test";
import { nearestPrice, createHistoricalPriceReader } from "./usdPrices.js";

const AT = new Date("2026-09-10T22:08:00Z");

test("the price closest to the moment is used", () => {
  const points = [
    { value: "0.020", timestamp: "2026-09-10T21:40:00Z" },
    { value: "0.029", timestamp: "2026-09-10T22:05:00Z" },
    { value: "0.040", timestamp: "2026-09-10T22:35:00Z" },
  ];
  expect(nearestPrice(points, AT)).toBe(0.029);
});

test("a single point is used whatever its distance", () => {
  expect(nearestPrice([{ value: "0.03", timestamp: "2026-09-10T20:00:00Z" }], AT)).toBe(0.03);
});

test("no points means no price rather than a guess", () => {
  expect(nearestPrice([], AT)).toBeNull();
  expect(nearestPrice(undefined, AT)).toBeNull();
});

test("unreadable values are skipped", () => {
  const points = [
    { value: "not-a-number", timestamp: "2026-09-10T22:05:00Z" },
    { value: "0.031", timestamp: "2026-09-10T22:15:00Z" },
  ];
  expect(nearestPrice(points, AT)).toBe(0.031);
});

test("a price is read for the moment asked for", async () => {
  const priceAt = createHistoricalPriceReader({
    apiKey: "k",
    now: () => 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ value: "0.0287", timestamp: AT.toISOString() }] }), { status: 200 }),
  });
  expect(await priceAt("STRK", AT)).toBe(0.0287);
});

test("an upstream failure gives no price rather than a wrong one", async () => {
  const priceAt = createHistoricalPriceReader({
    apiKey: "k",
    now: () => 0,
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  expect(await priceAt("STRK", AT)).toBeNull();
});

test("without a key there is no price", async () => {
  const priceAt = createHistoricalPriceReader({ apiKey: "", now: () => 0, fetchImpl: async () => new Response("{}") });
  expect(await priceAt("STRK", AT)).toBeNull();
});
