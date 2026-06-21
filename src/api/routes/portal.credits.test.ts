import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import portal from "./portal.js";

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", plan: "PREMIUM", status: "ACTIVE", creditBalance: 0 });
    await next();
  });
  a.route("/", portal);
  return a;
}

describe("POST /v1/portal/credits/fund", () => {
  test("400 when txHash is missing (no settlement attempted)", async () => {
    const res = await app().request("/credits/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
