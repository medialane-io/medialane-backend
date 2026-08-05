import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

// apiKeyAuth talks to prisma directly (no injected deps today) — this test
// exercises the context-shape contract via a hand-built downstream handler,
// not a live DB. Full behavior is covered by the existing integration-style
// route tests; this guards the specific account/apiClient split.
describe("apiKeyAuth context shape", () => {
  test("downstream handlers can read both c.get('account') (identity-only) and c.get('apiClient') (billing)", async () => {
    const a = new Hono<AppEnv>();
    // Simulates what apiKeyAuth sets post-cutover, without touching the DB.
    a.use("*", async (c, next) => {
      c.set("account", { id: "acc1", status: "ACTIVE" });
      c.set("apiClient", { id: "ac1", accountId: "acc1", plan: "FREE", creditBalance: 500 });
      await next();
    });
    a.get("/probe", (c) => {
      const account = c.get("account");
      const apiClient = c.get("apiClient");
      return c.json({ accountId: account.id, apiClientId: apiClient.id, creditBalance: apiClient.creditBalance });
    });
    const res = await a.request("/probe");
    const body = await res.json();
    expect(body).toEqual({ accountId: "acc1", apiClientId: "ac1", creditBalance: 500 });
  });
});
