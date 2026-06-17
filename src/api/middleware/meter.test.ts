import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";

let balanceOk = true;
mock.module("../../payments/credits.js", () => ({
  debitCredits: async () => balanceOk,
}));
mock.module("../../payments/x402.js", () => ({
  decodePaymentHeader: () => null,
  buildPaymentRequired: () => ({ x402Version: 1, accepts: [{ scheme: "starknet-transfer" }] }),
  settlePayment: async () => ({ ok: true, creditedAmount: 100 }),
}));
mock.module("../../payments/pricing.js", () => ({
  costForRequest: (_m: string, path: string) => (path.startsWith("/v1/portal") ? null : 1),
}));
mock.module("../../payments/schemes/starknet.js", () => ({
  StarknetUsdcScheme: class {
    scheme = "starknet-transfer";
    network = "starknet";
    buildRequirement() {
      return {};
    }
    verify() {
      return { ok: true };
    }
  },
}));
// Avoid pulling in the validated env via the real logger.
mock.module("../../utils/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { meter } = await import("./meter.js");

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("tenant", { id: "t1" } as never);
    await next();
  });
  a.use("/v1/*", meter());
  a.get("/v1/tokens", (c) => c.json({ ok: true }));
  a.get("/v1/portal/me", (c) => c.json({ ok: true }));
  return a;
}

describe("meter", () => {
  test("passes through when balance covers the cost", async () => {
    balanceOk = true;
    const res = await app().request("/v1/tokens");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-credits-remaining")).not.toBeNull();
  });
  test("returns 402 with x402 body when insufficient and no X-PAYMENT", async () => {
    balanceOk = false;
    const res = await app().request("/v1/tokens");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number };
    expect(body.x402Version).toBe(1);
    expect(res.headers.get("x-credits-remaining")).toBe("0");
  });
  test("skips metering for /v1/portal", async () => {
    balanceOk = false; // would 402 if metered
    const res = await app().request("/v1/portal/me");
    expect(res.status).toBe(200);
  });
});
