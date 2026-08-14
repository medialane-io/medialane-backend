import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
import { meter, type MeterDeps } from "./middleware/meter.js";
import { encodePaymentHeader } from "../payments/x402.js";

describe("x402 end-to-end", () => {
  test("unfunded → 402; pay via X-PAYMENT → 200; balance spent down", async () => {
    let balance = 0;
    const deps: MeterDeps = {
      costForRequest: async () => 1,
      debitCredits: async (_t: string, cost: number) => {
        if (balance >= cost) {
          balance -= cost;
          return true;
        }
        return false;
      },
      refundCredits: async (_t: string, cost: number) => {
        balance += cost;
      },
      settlePayment: async () => {
        balance += 100;
        return { ok: true, creditedAmount: 100 };
      },
    };

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("account", { id: "a1", status: "ACTIVE" });
      c.set("apiClient", { id: "ac1", accountId: "a1", plan: "FREE", creditBalance: 0 });
      await next();
    });
    app.use("/v1/*", meter(deps));
    app.get("/v1/tokens", (c) => c.json({ ok: true }));

    const first = await app.request("/v1/tokens");
    expect(first.status).toBe(402);
    const body = (await first.json()) as { x402Version: number };
    expect(body.x402Version).toBe(1);

    const header = encodePaymentHeader({
      scheme: "starknet-transfer",
      network: "starknet",
      txHash: "0xtx",
      nonce: "n1",
    });
    const paid = await app.request("/v1/tokens", { headers: { "x-payment": header } });
    expect(paid.status).toBe(200);
    expect(balance).toBe(99);

    const next = await app.request("/v1/tokens");
    expect(next.status).toBe(200);
    expect(balance).toBe(98);
  });
});
