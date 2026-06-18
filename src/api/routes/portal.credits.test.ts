import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import portal from "./portal.js";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("tenant", { id: "t1", name: "n", email: "e@x", plan: "PREMIUM", status: "ACTIVE" } as never);
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
