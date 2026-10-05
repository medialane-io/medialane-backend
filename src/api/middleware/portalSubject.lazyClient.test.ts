import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

function accountRow(over: { status?: string; apiCredits?: unknown } = {}) {
  return { id: "a1", status: over.status ?? "ACTIVE", sessionsValidFrom: null, apiCredits: over.apiCredits ?? null };
}

async function signIn(account: ReturnType<typeof accountRow> | null) {
  const created = { id: "ac-new", accountId: "a1", plan: "FREE", creditBalance: 0 };
  const ensureApiCredits = mock(async (_id?: string) => created);
  mock.module("../../db/client.js", () => ({
    default: { account: { findUnique: mock(async () => account) } },
  }));
  mock.module("../../utils/account.js", () => ({
    ensureAccountForWallet: async () => ({ accountId: "a1", created: false }),
    ensureApiCredits,
  }));
  const { portalSubject } = await import("./portalSubject.js");
  const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
  const app = new Hono<AppEnv>();
  app.use("*", portalSubject);
  app.get("/me", (c) => c.json({ apiCredits: c.get("apiCredits").id }));
  const res = await app.request("/me", { headers: { Authorization: `Bearer ${issueAccountSessionToken("a1")}` } });
  return { res, ensureApiCredits };
}

describe("signing in to the portal", () => {
  test("creates the account's ApiCredits the first time it is needed", async () => {
    const { res, ensureApiCredits } = await signIn(accountRow());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiCredits: "ac-new" });
    expect(ensureApiCredits).toHaveBeenCalledWith("a1");
  });

  test("uses the ApiCredits an account already has", async () => {
    const existing = { id: "ac-old", accountId: "a1", plan: "FREE", creditBalance: 5 };
    const { res, ensureApiCredits } = await signIn(accountRow({ apiCredits: existing }));
    expect(await res.json()).toEqual({ apiCredits: "ac-old" });
    expect(ensureApiCredits).not.toHaveBeenCalled();
  });

  test("never creates one for an inactive account", async () => {
    const { res, ensureApiCredits } = await signIn(accountRow({ status: "INACTIVE" }));
    expect(res.status).toBe(403);
    expect(ensureApiCredits).not.toHaveBeenCalled();
  });

  test("an unknown account is not found, and nothing is created", async () => {
    const { res, ensureApiCredits } = await signIn(null);
    expect(res.status).toBe(404);
    expect(ensureApiCredits).not.toHaveBeenCalled();
  });
});
