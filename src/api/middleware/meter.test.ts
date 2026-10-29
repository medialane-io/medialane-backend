import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { meter, type MeterDeps } from "./meter.js";
import { bill } from "../../payments/usage.js";

type TestDeps = Partial<MeterDeps> & {
  onRefund?: (apiCreditsId: string, credits: number) => void | Promise<void>;
};

function deps(over: TestDeps = {}): MeterDeps {
  const { onRefund, ...rest } = over;
  return {
    chargeForRequest: async (_m: string, path: string) =>
      path.startsWith("/v1/portal")
        ? null
        : { actionKey: "read", chain: "STARKNET", service: "ALL", unitCredits: 1, units: 1 },
    charge: async () => true,
    settlePayment: async () => ({ ok: true, creditedAmount: 100 }),
    returnCharge: async (apiCreditsId: string, credits: number) => {
      await onRefund?.(apiCreditsId, credits);
    },
    ...rest,
  };
}

function app(d: MeterDeps) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", status: "ACTIVE" });
    c.set("apiCredits", { id: "ac1", accountId: "a1", creditBalance: 100 });
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
  a.get("/v1/reused-read", (c) => {
    bill(c, 0, 1);
    return c.json({ reusedExistingWallet: true });
  });
  a.get("/v1/over", (c) => {
    bill(c, 0, 99);
    return c.json({ ok: true });
  });
  a.get("/v1/fail-named", (c) => {
    bill(c, 0, 1);
    return c.json({ error: "server error" }, 500);
  });
  a.get("/v1/fail", (c) => c.json({ error: "server error" }, 500));
  a.get("/v1/boom", () => {
    throw new Error("handler blew up");
  });
  a.onError((_err, c) => c.json({ error: "Internal server error" }, 500));
  return a;
}

describe("meter", () => {
  test("the response does not wait for a returned charge", async () => {
    const res = await Promise.race([
      app(deps({ onRefund: () => new Promise<void>(() => {}) })).request("/v1/fail"),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(res).not.toBe("hung");
    expect((res as Response).status).toBe(500);
  });
  test("passes through when balance covers the cost", async () => {
    const res = await app(deps({ charge: async () => true })).request("/v1/tokens");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-credits-remaining")).not.toBeNull();
  });
  test("returns 402 with x402 body when insufficient and no X-PAYMENT", async () => {
    const res = await app(deps({ charge: async () => false })).request("/v1/tokens");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: unknown[]; code?: string };
    expect(body.x402Version).toBe(1);
    expect(body.code).toBe("credits_exhausted");
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(res.headers.get("x-credits-remaining")).toBe("0");
  });
  test("skips metering for /v1/portal", async () => {
    const res = await app(deps({ charge: async () => false })).request("/v1/portal/me");
    expect(res.status).toBe(200);
  });

  test("does NOT refund on a successful 2xx", async () => {
    let refunds = 0;
    const res = await app(deps({ onRefund: async () => { refunds++; } })).request("/v1/tokens");
    expect(res.status).toBe(200);
    expect(refunds).toBe(0);
  });

  test("does NOT refund a 4xx (caller's bad input)", async () => {
    let refunds = 0;
    const res = await app(deps({ onRefund: async () => { refunds++; } })).request("/v1/bad");
    expect(res.status).toBe(400);
    expect(refunds).toBe(0);
  });

  test("refunds the reservation on a 5xx", async () => {
    let refunded = 0;
    const res = await app(deps({ onRefund: async (_id, cost) => { refunded += cost; } })).request("/v1/fail");
    expect(res.status).toBe(500);
    expect(refunded).toBe(1);
  });

  test("refunds and still surfaces a 500 when the handler throws", async () => {
    let refunded = 0;
    const res = await app(deps({ onRefund: async (_id, cost) => { refunded += cost; } })).request("/v1/boom");
    expect(res.status).toBe(500);
    expect(refunded).toBe(1);
  });

  test("a handler that did nothing billable keeps none of the hold", async () => {
    let refunded = 0;
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "wallet:deploy", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 1 }),
      onRefund: async (_id, cost) => { refunded += cost; },
    });
    const res = await app(d).request("/v1/reused");

    expect(res.status).toBe(200);
    expect(refunded).toBe(5);
  });

  test("a handler that names its credits keeps exactly those", async () => {
    let refunded = 0;
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "wallet:deploy", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 1 }),
      onRefund: async (_id, cost) => { refunded += cost; },
    });
    const res = await app(d).request("/v1/reused-read");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Credits-Remaining")).toBe("99");
    expect(refunded).toBe(4);
  });

  test("named credits never exceed the hold", async () => {
    let refunded = 0;
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "wallet:deploy", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 1 }),
      onRefund: async (_id, cost) => { refunded += cost; },
    });
    await app(d).request("/v1/over");

    expect(refunded).toBe(0);
  });

  test("a server error keeps the credits the handler named", async () => {
    let refunded = 0;
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "paymaster:invoke-execute", chain: "STARKNET", service: "ALL", unitCredits: 2, units: 1 }),
      onRefund: async (_id, cost) => { refunded += cost; },
    });
    const res = await app(d).request("/v1/fail-named");

    expect(res.status).toBe(500);
    expect(refunded).toBe(1);
  });

  test("a batch is held and settled at its real size", async () => {
    let debited = 0;
    let refunded = 0;
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "rpc:call", chain: "STARKNET", service: "ALL", unitCredits: 2, units: 10 }),
      charge: async (_id, cost) => { debited = cost; return true; },
      onRefund: async (_id, cost) => { refunded += cost; },
    });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("account", { id: "a1", status: "ACTIVE" });
      c.set("apiCredits", { id: "ac1", accountId: "a1", creditBalance: 100 });
      await next();
    });
    a.use("/v1/*", meter(d));
    a.get("/v1/rpc", (c) => { bill(c, 4); return c.json({ ok: true }); });
    await a.request("/v1/rpc");

    expect(debited).toBe(20);
    expect(refunded).toBe(12);
  });

  test("a failed charge return never fails the request", async () => {
    const res = await app(deps({ onRefund: async () => { throw new Error("db down"); } })).request("/v1/fail");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server error" });
  });

  test("what is left reflects what was kept, not what was held", async () => {
    const d = deps({
      chargeForRequest: async () => ({ actionKey: "wallet:deploy", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 1 }),
    });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("account", { id: "a1", status: "ACTIVE" });
      c.set("apiCredits", { id: "ac1", accountId: "a1", creditBalance: 100 });
      await next();
    });
    a.use("/v1/*", meter(d));
    a.get("/v1/one", (c) => { bill(c, 1); return c.json({ ok: true }); });
    const res = await a.request("/v1/one");
    expect(res.headers.get("x-credits-remaining")).toBe("95");
  });
});
