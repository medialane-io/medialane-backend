import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import portal from "./portal.js";

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", status: "ACTIVE" });
    c.set("apiClient", { id: "ac1", accountId: "a1", plan: "PREMIUM", creditBalance: 0 });
    await next();
  });
  a.route("/", portal);
  return a;
}

describe("crediting is not something a caller can ask for", () => {
  test("a caller cannot report that it paid", () => {
    const funding = portal.routes.filter((r) => r.path.includes("fund"));
    expect(funding).toEqual([]);
  });

  test("the ledger is still readable", async () => {
    const res = await app().request("/credits/history");
    expect(res.status).not.toBe(404);
  });
});
