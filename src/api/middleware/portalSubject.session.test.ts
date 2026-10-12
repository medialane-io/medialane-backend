import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

function accountRow(status: string) {
  return {
    id: "a1",
    status,
    apiCredits: { id: "ac1", accountId: "a1", creditBalance: 0 },
  };
}

async function appFor(status: string) {
  mock.module("../../db/client.js", () => ({
    default: { account: { findUnique: mock(() => Promise.resolve(accountRow(status))) } },
  }));
  const { portalSubject } = await import("./portalSubject.js");
  const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
  const app = new Hono<AppEnv>();
  app.use("*", portalSubject);
  app.get("/me", (c) => c.json({ ok: true }));
  const request = (token: string) => app.request("/me", { headers: { Authorization: `Bearer ${token}` } });
  const forwarded = (token: string) => app.request("/me", { headers: { "x-account-session": token } });
  return { request, forwarded, token: issueAccountSessionToken("a1") };
}

describe("account sessions on the portal", () => {
  test("a session keeps working for an active or pending account", async () => {
    for (const status of ["ACTIVE", "PENDING"]) {
      const { request, token } = await appFor(status);
      expect((await request(token)).status).toBe(200);
    }
  });

  test("an inactive account's session is refused", async () => {
    const { request, token } = await appFor("INACTIVE");
    const res = await request(token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Account is not active" });
  });

  test("the forwarded session header signs the portal request in", async () => {
    const { forwarded, token } = await appFor("ACTIVE");
    expect((await forwarded(token)).status).toBe(200);
  });
});
