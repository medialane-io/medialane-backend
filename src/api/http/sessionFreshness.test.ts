import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { refuseStaleSession, sessionPredatesVerification } from "./sessionFreshness.js";

const VERIFIED_AT = new Date("2026-11-02T12:00:00Z");
const BEFORE = Math.floor(VERIFIED_AT.getTime() / 1000) - 3600;
const AFTER = Math.floor(VERIFIED_AT.getTime() / 1000) + 60;

const verifiedAt = (date: Date | null) => ({ verifiedAt: async () => date });

describe("sessionPredatesVerification", () => {
  test("a session issued after verification is fresh", async () => {
    expect(await sessionPredatesVerification("acc", AFTER, verifiedAt(VERIFIED_AT))).toBe(false);
  });

  test("a session issued before verification predates it", async () => {
    expect(await sessionPredatesVerification("acc", BEFORE, verifiedAt(VERIFIED_AT))).toBe(true);
  });

  test("a session issued in the same second as verification is fresh", async () => {
    const verified = new Date(VERIFIED_AT.getTime() + 400);
    expect(await sessionPredatesVerification("acc", Math.floor(VERIFIED_AT.getTime() / 1000), verifiedAt(verified))).toBe(false);
  });

  test("a session up to a minute before the recorded verification is fresh (clocks may differ)", async () => {
    expect(await sessionPredatesVerification("acc", Math.floor(VERIFIED_AT.getTime() / 1000) - 59, verifiedAt(VERIFIED_AT))).toBe(false);
  });

  test("an account that was never pending is never stale", async () => {
    expect(await sessionPredatesVerification("acc", BEFORE, verifiedAt(null))).toBe(false);
  });
});

function appWith(vars: { sessionAccountId?: string; sessionIssuedAt?: number }, at: Date | null) {
  const app = new Hono<AppEnv>();
  app.post("/change", async (c) => {
    if (vars.sessionAccountId) c.set("sessionAccountId", vars.sessionAccountId);
    if (vars.sessionIssuedAt !== undefined) c.set("sessionIssuedAt", vars.sessionIssuedAt);
    const refused = await refuseStaleSession(c, verifiedAt(at));
    return refused ?? c.json({ ok: true });
  });
  return app;
}

describe("refuseStaleSession", () => {
  test("a session issued after verification can make the change", async () => {
    const res = await appWith({ sessionAccountId: "acc", sessionIssuedAt: AFTER }, VERIFIED_AT).request("/change", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("a session issued before verification is refused with sign_in_again", async () => {
    const res = await appWith({ sessionAccountId: "acc", sessionIssuedAt: BEFORE }, VERIFIED_AT).request("/change", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Sign in again to make this change", code: "sign_in_again" });
  });

  test("a request authenticated by a wallet signature is not checked", async () => {
    const res = await appWith({}, VERIFIED_AT).request("/change", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
