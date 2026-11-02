import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { ACCOUNT_CHANGE_ROUTES, createAccountChangeGuard } from "./accountChangeGuard.js";

const VERIFIED_AT = new Date("2026-11-02T12:00:00Z");
const STALE = "account_session_stale";
const FRESH = "account_session_fresh";
const issued: Record<string, number> = {
  [STALE]: Math.floor(VERIFIED_AT.getTime() / 1000) - 3600,
  [FRESH]: Math.floor(VERIFIED_AT.getTime() / 1000) + 60,
};

function appWith(verifiedAt: Date | null = VERIFIED_AT) {
  const handled: string[] = [];
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    createAccountChangeGuard({
      session: async (raw) => (raw in issued ? { accountId: "acc_1", issuedAt: issued[raw]! } : null),
      freshness: { verifiedAt: async () => verifiedAt },
    }),
  );
  app.all("*", (c) => {
    handled.push(`${c.req.method} ${c.req.path}`);
    return c.json({ ok: true });
  });
  return { app, handled };
}

const call = (app: Hono<AppEnv>, method: string, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method, headers });

describe("account-change guard", () => {
  test("a session issued before verification is refused on every account-change route, before the route runs", async () => {
    for (const [method, path] of ACCOUNT_CHANGE_ROUTES) {
      const { app, handled } = appWith();
      const res = await call(app, method, path, { "x-account-session": STALE });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Sign in again to make this change", code: "sign_in_again" });
      expect(handled).toEqual([]);
    }
  });

  test("an account session sent as a bearer token is checked too", async () => {
    const { app } = appWith();
    const res = await call(app, "POST", "/v1/paymaster/deploy/execute", { authorization: `Bearer ${STALE}` });
    expect(res.status).toBe(403);
  });

  test("a session issued after verification makes the change", async () => {
    const { app, handled } = appWith();
    const res = await call(app, "POST", "/v1/users/me/wallet/key", { "x-account-session": FRESH });
    expect(res.status).toBe(200);
    expect(handled).toEqual(["POST /v1/users/me/wallet/key"]);
  });

  test("a pending account's session is never refused", async () => {
    const { app } = appWith(null);
    expect((await call(app, "POST", "/v1/paymaster/deploy/execute", { "x-account-session": STALE })).status).toBe(200);
  });

  test("other routes are not checked, so an older session still reads the account", async () => {
    const { app } = appWith();
    expect((await call(app, "GET", "/v1/users/me", { "x-account-session": STALE })).status).toBe(200);
    expect((await call(app, "POST", "/v1/users/me/wallet", { "x-account-session": STALE })).status).toBe(200);
  });

  test("requests without an account session, or with one that does not verify, are left to the route", async () => {
    const { app } = appWith();
    expect((await call(app, "POST", "/v1/users/me/email", { authorization: "Bearer siws_wallet.sig" })).status).toBe(200);
    expect((await call(app, "POST", "/v1/users/me/email", { "x-account-session": "account_session_unknown" })).status).toBe(200);
  });
});

test("every account-change route exists in the app", async () => {
  const { createApp } = await import("../server.js");
  const routes = new Set(createApp().routes.map((r) => `${r.method} ${r.path}`));
  for (const [method, path] of ACCOUNT_CHANGE_ROUTES) expect(routes.has(`${method} ${path}`)).toBe(true);
});

test("the guard runs in the app ahead of the routes", async () => {
  const { createApp } = await import("../server.js");
  const app = createApp();
  const guardIndex = app.routes.findIndex((r) => r.handler.name === "accountChangeGuard");
  const routeIndex = app.routes.findIndex((r) => r.path === "/v1/users/me/wallet/key" && r.method === "POST");
  expect(guardIndex).toBeGreaterThan(-1);
  expect(guardIndex).toBeLessThan(routeIndex);
});
