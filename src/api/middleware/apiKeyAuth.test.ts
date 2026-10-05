import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

describe("apiKeyAuth context shape", () => {
  test("downstream handlers can read both c.get('account') (identity-only) and c.get('apiCredits') (billing)", async () => {
    const a = new Hono<AppEnv>();

    a.use("*", async (c, next) => {
      c.set("account", { id: "acc1", status: "ACTIVE" });
      c.set("apiCredits", { id: "ac1", accountId: "acc1", creditBalance: 500 });
      await next();
    });
    a.get("/probe", (c) => {
      const account = c.get("account");
      const apiCredits = c.get("apiCredits");
      return c.json({ accountId: account.id, apiCreditsId: apiCredits.id, creditBalance: apiCredits.creditBalance });
    });
    const res = await a.request("/probe");
    const body = await res.json();
    expect(body).toEqual({ accountId: "acc1", apiCreditsId: "ac1", creditBalance: 500 });
  });
});
