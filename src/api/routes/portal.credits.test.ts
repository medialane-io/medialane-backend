import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import portal from "./portal.js";

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", status: "ACTIVE" });
    c.set("apiCredits", { id: "ac1", accountId: "a1", plan: "PREMIUM", creditBalance: 0 });
    await next();
  });
  a.route("/", portal);
  return a;
}

describe("crediting is not something a caller can ask for", () => {
  test("a caller cannot report that it paid", () => {
    const reporting = portal.routes.filter((r) => /report|paid|claim/i.test(r.path));
    expect(reporting).toEqual([]);
  });

  test("funding routes exist, and none takes a credit amount or a paid amount in its path", () => {
    const paths = portal.routes.filter((r) => r.path.startsWith("/funding")).map((r) => r.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => /credit|amount|paid/i.test(p))).toBe(false);
  });

  test("the ledger is still readable", async () => {
    const res = await app().request("/credits/history");
    expect(res.status).not.toBe(404);
  });
});
