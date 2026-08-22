import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import swap, { resolveSwapToken, resolveSwapAmount } from "./swap.js";
import type { AppEnv } from "../../types/hono.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

describe("resolveSwapToken", () => {
  test("resolves a catalogue symbol", () => {
    expect(resolveSwapToken({ symbol: "STRK" })?.address).toBe(STRK);
  });

  test("resolves an arbitrary contract address", () => {
    const out = resolveSwapToken({ address: "0x123abc" });
    expect(out).not.toBeNull();
    expect(out!.address.startsWith("0x")).toBe(true);
  });

  test("requires exactly one of symbol or address", () => {
    expect(resolveSwapToken({})).toBeNull();
    expect(resolveSwapToken({ symbol: "STRK", address: "0x1" })).toBeNull();
  });

  test("rejects an unknown symbol and a malformed address", () => {
    expect(resolveSwapToken({ symbol: "NOPE" })).toBeNull();
    expect(resolveSwapToken({ address: "not-an-address" })).toBeNull();
  });
});

describe("resolveSwapAmount", () => {
  test("accepts a sell-side amount", () => {
    expect(resolveSwapAmount({ sellAmountRaw: "1000" })).toEqual({ sellAmount: 1000n });
  });

  test("accepts a buy-side amount", () => {
    expect(resolveSwapAmount({ buyAmountRaw: "250" })).toEqual({ buyAmount: 250n });
  });

  test("requires exactly one side", () => {
    expect(resolveSwapAmount({})).toBeNull();
    expect(resolveSwapAmount({ sellAmountRaw: "1", buyAmountRaw: "2" })).toBeNull();
  });

  test("rejects a non-numeric amount", () => {
    expect(resolveSwapAmount({ sellAmountRaw: "abc" })).toBeNull();
  });
});

describe("POST /quote", () => {
  function appWith(deps: Parameters<typeof swap>[0]) {
    const app = new Hono<AppEnv>();
    app.route("/", swap(deps));
    return app;
  }

  test("returns the best quote for a valid pair", async () => {
    const app = appWith({
      getQuotes: async () => [{ quoteId: "q1", sellAmount: 5n }] as never,
      quoteToCalls: async () => ({ calls: [], chainId: "0x1" }) as never,
    });

    const res = await app.request("/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellSymbol: "STRK", buySymbol: "USDC", sellAmountRaw: "1000" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.quote.quoteId).toBe("q1");
    expect(json.quote.sellAmount).toBe("5");
  });

  test("rejects a request that names neither a symbol nor an address", async () => {
    let called = false;
    const app = appWith({
      getQuotes: async () => {
        called = true;
        return [] as never;
      },
      quoteToCalls: async () => ({}) as never,
    });

    const res = await app.request("/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellAmountRaw: "1000" }),
    });

    expect(called).toBe(false);
    expect(res.status).toBe(400);
  });

  test("reports an empty route set as a 502", async () => {
    const app = appWith({
      getQuotes: async () => [] as never,
      quoteToCalls: async () => ({}) as never,
    });

    const res = await app.request("/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellSymbol: "STRK", buySymbol: "USDC", sellAmountRaw: "1000" }),
    });

    expect(res.status).toBe(502);
  });
});

describe("POST /build", () => {
  function appWith(deps: Parameters<typeof swap>[0]) {
    const app = new Hono<AppEnv>();
    app.route("/", swap(deps));
    return app;
  }

  test("returns calls, chainId and the quote", async () => {
    const app = appWith({
      getQuotes: async () => [{ quoteId: "q1" }] as never,
      quoteToCalls: async () => ({ calls: [{ to: "0x1" }], chainId: 5n }) as never,
    });

    const res = await app.request("/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellSymbol: "STRK",
        buySymbol: "USDC",
        sellAmountRaw: "1000",
        takerAddress: "0xabc",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.calls).toEqual([{ to: "0x1" }]);
    expect(json.chainId).toBe("5");
    expect(json.quote.quoteId).toBe("q1");
  });

  test("requires a taker address", async () => {
    let called = false;
    const app = appWith({
      getQuotes: async () => {
        called = true;
        return [] as never;
      },
      quoteToCalls: async () => ({}) as never,
    });

    const res = await app.request("/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellSymbol: "STRK", buySymbol: "USDC", sellAmountRaw: "1000" }),
    });

    expect(called).toBe(false);
    expect(res.status).toBe(400);
  });
});
