import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { meter, type MeterDeps } from "./meter.js";
import { bill, type UsageRecord } from "../../payments/usage.js";

function deps(over: Partial<MeterDeps> = {}): MeterDeps {
  return {
    chargeForRequest: async (_m: string, path: string) =>
      path.startsWith("/v1/portal")
        ? null
        : { actionKey: "read", chain: "STARKNET", service: "ALL", unitCredits: 1, units: 1 },
    debitCredits: async () => true,
    refundCredits: async () => {},
    settlePayment: async () => ({ ok: true, creditedAmount: 100 }),
    recordUsage: async () => {},
    ...over,
  } as MeterDeps;
}

function app(d: MeterDeps) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", status: "ACTIVE" });
    c.set("apiClient", { id: "ac1", accountId: "a1", plan: "FREE", creditBalance: 100 });
    await next();
  });
  a.use("/v1/*", meter(d));
  a.get("/v1/tokens", (c) => c.json({ ok: true }));
  a.get("/v1/portal/me", (c) => c.json({ ok: true }));
  a.get("/v1/bad", (c) => c.json({ error: "bad input" }, 400));
  a.get("/v1/reused", (c) => {
    bill(c, 0);
    return c.json({ reusedExistingWallet: true });
  });
  a.get("/v1/fail", (c) => c.json({ error: "server error" }, 500));
  a.get("/v1/boom", () => {
    throw new Error("handler blew up");
  });
  a.onError((_err, c) => c.json({ error: "Internal server error" }, 500));
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

  test("does NOT refund on a successful 2xx", async () => {
    let refunds = 0;
    const res = await app(deps({ refundCredits: async () => { refunds++; } })).request("/v1/tokens");
    expect(res.status).toBe(200);
    expect(refunds).toBe(0);
  });

  test("does NOT refund a 4xx (caller's bad input)", async () => {
    let refunds = 0;
    const res = await app(deps({ refundCredits: async () => { refunds++; } })).request("/v1/bad");
    expect(res.status).toBe(400);
    expect(refunds).toBe(0);
  });

  test("refunds the reservation on a 5xx", async () => {
    let refunded = 0;
    const res = await app(deps({ refundCredits: async (_id, cost) => { refunded += cost; } })).request("/v1/fail");
    expect(res.status).toBe(500);
    expect(refunded).toBe(1);
  });

  test("refunds and still surfaces a 500 when the handler throws", async () => {
    let refunded = 0;
    const res = await app(deps({ refundCredits: async (_id, cost) => { refunded += cost; } })).request("/v1/boom");
    expect(res.status).toBe(500);
    expect(refunded).toBe(1);
  });

  test("a handler that did nothing billable keeps none of the hold", async () => {
    let refunded = 0;
    const rows: UsageRecord[] = [];
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "wallet:deploy", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 1 }),
      refundCredits: async (_id, cost) => { refunded += cost; },
      recordUsage: async (row) => { rows.push(row); },
    });
    const res = await app(d).request("/v1/reused");

    expect(res.status).toBe(200);
    expect(refunded).toBe(5);
    expect(rows[0].units).toBe(0);
    expect(rows[0].credits).toBe(0);
  });

  test("every metered request leaves one usage row", async () => {
    const rows: UsageRecord[] = [];
    await app(deps({ recordUsage: async (row) => { rows.push(row); } })).request("/v1/tokens");

    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      apiClientId: "ac1",
      actionKey: "read",
      chain: "STARKNET",
      service: "ALL",
      unitCredits: 1,
      units: 1,
      credits: 1,
      method: "GET",
      path: "/v1/tokens",
      status: 200,
    });
  });

  test("a 5xx is recorded as spent nothing", async () => {
    const rows: UsageRecord[] = [];
    await app(deps({ recordUsage: async (row) => { rows.push(row); } })).request("/v1/fail");
    expect(rows[0]).toMatchObject({ units: 0, credits: 0, status: 500 });
  });

  test("a thrown handler is recorded as spent nothing", async () => {
    const rows: UsageRecord[] = [];
    await app(deps({ recordUsage: async (row) => { rows.push(row); } })).request("/v1/boom");
    expect(rows[0]).toMatchObject({ units: 0, credits: 0 });
  });

  test("a batch is held and settled at its real size", async () => {
    const rows: UsageRecord[] = [];
    let debited = 0;
    let refunded = 0;
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "rpc:call", chain: "STARKNET", service: "ALL", unitCredits: 2, units: 10 }),
      debitCredits: async (_id, cost) => { debited = cost; return true; },
      refundCredits: async (_id, cost) => { refunded += cost; },
      recordUsage: async (row) => { rows.push(row); },
    });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("account", { id: "a1", status: "ACTIVE" });
      c.set("apiClient", { id: "ac1", accountId: "a1", plan: "FREE", creditBalance: 100 });
      await next();
    });
    a.use("/v1/*", meter(d));
    a.get("/v1/rpc", (c) => { bill(c, 4); return c.json({ ok: true }); });
    await a.request("/v1/rpc");

    expect(debited).toBe(20);
    expect(refunded).toBe(12);
    expect(rows[0]).toMatchObject({ units: 4, credits: 8 });
  });

  test("a failed usage write never fails the request", async () => {
    const res = await app(deps({ recordUsage: async () => { throw new Error("db down"); } })).request("/v1/tokens");
    expect(res.status).toBe(200);
  });

  test("what is left reflects what was kept, not what was held", async () => {
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "wallet:deploy", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 1 }),
    });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("account", { id: "a1", status: "ACTIVE" });
      c.set("apiClient", { id: "ac1", accountId: "a1", plan: "FREE", creditBalance: 100 });
      await next();
    });
    a.use("/v1/*", meter(d));
    a.get("/v1/one", (c) => { bill(c, 1); return c.json({ ok: true }); });
    const res = await a.request("/v1/one");
    expect(res.headers.get("x-credits-remaining")).toBe("95");
  });
});
