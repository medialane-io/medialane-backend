import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

async function appFor(account: { status: string } | null) {
  mock.module("../../db/client.js", () => ({
    default: {
      account: { findUnique: mock(() => Promise.resolve(account)) },
      identity: { findFirst: mock(() => Promise.resolve(null)) },
    },
  }));
  const { requireSession } = await import("./sessionGuard.js");
  const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
  const { issueToken } = await import("../../utils/siwsToken.js");
  const app = new Hono<AppEnv>();
  app.use("*", requireSession);
  app.post("/", (c) => c.json({ ok: true }));
  return { app, account: issueAccountSessionToken("a1"), siws: issueToken("STARKNET", "0x1") };
}

const call = (app: Hono<AppEnv>, headers: Record<string, string> = {}) => app.request("/", { method: "POST", headers });

describe("gas sponsorship sign-in", () => {
  test("a request with no sign-in is refused", async () => {
    const { app } = await appFor({ status: "ACTIVE" });
    const res = await call(app);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request_auth");
  });

  test("a forged or malformed session is refused", async () => {
    const { app } = await appFor({ status: "ACTIVE" });
    expect((await call(app, { "x-account-session": "not-a-token" })).status).toBe(401);
    expect((await call(app, { authorization: "Bearer nope" })).status).toBe(401);
  });

  test("a valid forwarded account session is accepted", async () => {
    const { app, account } = await appFor({ status: "ACTIVE" });
    expect((await call(app, { "x-account-session": account })).status).toBe(200);
  });

  test("a valid account token or SIWS token in Authorization is accepted", async () => {
    const { app, account, siws } = await appFor({ status: "ACTIVE" });
    expect((await call(app, { authorization: `Bearer ${account}` })).status).toBe(200);
    expect((await call(app, { authorization: `Bearer ${siws}` })).status).toBe(200);
  });

  test("an inactive account's session is refused", async () => {
    const { app, account } = await appFor({ status: "INACTIVE" });
    expect((await call(app, { "x-account-session": account })).status).toBe(401);
  });

});

const W = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("sponsor wallet", () => {
  async function walletApp() {
    const { createRequireSession } = await import("./sessionGuard.js");
    const deps = {
      accountFromSession: async (raw: string) => (raw === "good-session" ? "acc1" : null),
      walletOf: async (accountId: string) => (accountId === "acc1" ? W : null),
      siwsIdentity: (raw: string) => (raw === "good-siws" ? { chain: "STARKNET" as const, address: W } : null),
    };
    const app = new Hono<AppEnv>();
    app.post("/", createRequireSession(deps), (c) => c.json({ wallet: c.get("sponsorWallet") ?? null }));
    return app;
  }

  test("a session sets the account's wallet", async () => {
    const res = await (await walletApp()).request("/", { method: "POST", headers: { "x-account-session": "good-session" } });
    expect(await res.json()).toEqual({ wallet: W });
  });

  test("a SIWS token sets its wallet", async () => {
    const res = await (await walletApp()).request("/", { method: "POST", headers: { authorization: "Bearer good-siws" } });
    expect(await res.json()).toEqual({ wallet: W });
  });

  test("no proof is refused", async () => {
    const res = await (await walletApp()).request("/", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("session account", () => {
  async function accountApp() {
    const { createRequireSession } = await import("./sessionGuard.js");
    const guard = createRequireSession({
      accountFromSession: async (raw) => (raw === "acct-session" ? "acct-1" : null),
      walletOf: async () => null,
      siwsIdentity: (raw) => (raw === "siws" ? { chain: "STARKNET", address: "0x1" } : null),
    });
    const app = new Hono<AppEnv>();
    app.use("*", guard);
    app.post("/", (c) => c.json({ accountId: c.get("sessionAccountId") ?? null }));
    return app;
  }

  test("an account session exposes its account id", async () => {
    const app = await accountApp();
    const res = await app.request("/", { method: "POST", headers: { "x-account-session": "acct-session" } });
    expect(await res.json()).toEqual({ accountId: "acct-1" });
  });

  test("a SIWS-only request has no account id", async () => {
    const app = await accountApp();
    const res = await app.request("/", { method: "POST", headers: { authorization: "Bearer siws" } });
    expect(await res.json()).toEqual({ accountId: null });
  });
});
