import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

function accountRow(sessionsValidFrom: Date | null) {
  return {
    id: "a1",
    status: "ACTIVE",
    sessionsValidFrom,
    apiCredits: { id: "ac1", accountId: "a1", plan: "FREE", creditBalance: 0 },
  };
}

async function appFor(sessionsValidFrom: Date | null) {
  mock.module("../../db/client.js", () => ({
    default: { account: { findUnique: mock(() => Promise.resolve(accountRow(sessionsValidFrom))) } },
  }));
  const { portalSubject } = await import("./portalSubject.js");
  const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
  const app = new Hono<AppEnv>();
  app.use("*", portalSubject);
  app.get("/me", (c) => c.json({ ok: true }));
  const request = (token: string) => app.request("/me", { headers: { Authorization: `Bearer ${token}` } });
  return { request, token: issueAccountSessionToken("a1") };
}

describe("account sessions and the verification cutoff", () => {
  test("a session issued before the account was verified is refused", async () => {
    const { request, token } = await appFor(new Date(Date.now() + 60_000));
    const res = await request(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired token" });
  });

  test("a session issued after the cutoff is accepted", async () => {
    const { request, token } = await appFor(new Date(Date.now() - 60_000));
    expect((await request(token)).status).toBe(200);
  });

  test("an account with no cutoff keeps its sessions", async () => {
    const { request, token } = await appFor(null);
    expect((await request(token)).status).toBe(200);
  });
});
