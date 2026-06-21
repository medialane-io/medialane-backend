import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { meter, type MeterDeps } from "./meter.js";

// Stub deps — no module mocking, so nothing leaks across test files.
function deps(over: Partial<MeterDeps> = {}): MeterDeps {
  return {
    costForRequest: (_m: string, path: string) => (path.startsWith("/v1/portal") ? null : 1),
    debitCredits: async () => true,
    settlePayment: async () => ({ ok: true, creditedAmount: 100 }),
    ...over,
  } as MeterDeps;
}

function app(d: MeterDeps) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", plan: "FREE", status: "ACTIVE", creditBalance: 100 });
    await next();
  });
  a.use("/v1/*", meter(d));
  a.get("/v1/tokens", (c) => c.json({ ok: true }));
  a.get("/v1/portal/me", (c) => c.json({ ok: true }));
  return a;
}

describe("meter", () => {
  test("passes through when balance covers the cost", async () => {
    const res = await app(deps({ debitCredits: async () => true })).request("/v1/tokens");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-credits-remaining")).not.toBeNull();
  });
  test("returns 402 with x402 body when insufficient and no X-PAYMENT", async () => {
    const res = await app(deps({ debitCredits: async () => false })).request("/v1/tokens");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: unknown[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(res.headers.get("x-credits-remaining")).toBe("0");
  });
  test("skips metering for /v1/portal", async () => {
    const res = await app(deps({ debitCredits: async () => false })).request("/v1/portal/me");
    expect(res.status).toBe(200);
  });
});
