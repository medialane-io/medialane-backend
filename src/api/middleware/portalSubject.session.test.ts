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
  const request = (token: string) => app.request("/me", { headers: { "x-account-session": token } });
  const bearer = (token: string) => app.request("/me", { headers: { Authorization: `Bearer ${token}` } });
  return { request, bearer, token: issueAccountSessionToken("a1") };
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

  test("only the forwarded session signs in; a token in Authorization does not", async () => {
    const { bearer, token } = await appFor("ACTIVE");
    const { issueToken } = await import("../../utils/siwsToken.js");
    for (const t of [token, issueToken("STARKNET", "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7")]) {
      const res = await bearer(t);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Sign in to use the portal" });
    }
  });
});
