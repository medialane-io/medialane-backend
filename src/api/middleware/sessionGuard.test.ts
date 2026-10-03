import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

async function appFor(account: { status: string; sessionsValidFrom: Date | null } | null) {
  mock.module("../../db/client.js", () => ({
    default: { account: { findUnique: mock(() => Promise.resolve(account)) } },
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
    const { app } = await appFor({ status: "ACTIVE", sessionsValidFrom: null });
    const res = await call(app);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request_auth");
  });

  test("a forged or malformed session is refused", async () => {
    const { app } = await appFor({ status: "ACTIVE", sessionsValidFrom: null });
    expect((await call(app, { "x-account-session": "not-a-token" })).status).toBe(401);
    expect((await call(app, { authorization: "Bearer nope" })).status).toBe(401);
  });

  test("a valid forwarded account session is accepted", async () => {
    const { app, account } = await appFor({ status: "ACTIVE", sessionsValidFrom: null });
    expect((await call(app, { "x-account-session": account })).status).toBe(200);
  });

  test("a valid account token or SIWS token in Authorization is accepted", async () => {
    const { app, account, siws } = await appFor({ status: "ACTIVE", sessionsValidFrom: null });
    expect((await call(app, { authorization: `Bearer ${account}` })).status).toBe(200);
    expect((await call(app, { authorization: `Bearer ${siws}` })).status).toBe(200);
  });

  test("an inactive account's session is refused", async () => {
    const { app, account } = await appFor({ status: "INACTIVE", sessionsValidFrom: null });
    expect((await call(app, { "x-account-session": account })).status).toBe(401);
  });

  test("a session older than the account's cutoff is refused", async () => {
    const { app, account } = await appFor({ status: "ACTIVE", sessionsValidFrom: new Date(Date.now() + 60_000) });
    expect((await call(app, { "x-account-session": account })).status).toBe(401);
  });
});
