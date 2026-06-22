import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createAdminSessionGrant, encodeAdminHeaders, type AdminSession } from "@medialane/sdk";
import { createAdminSignatureAuth, type AdminSigDeps } from "./adminSignatureAuth.js";

const FIXED_NOW = 1_700_000_000_000;

async function makeSession(): Promise<AdminSession> {
  return createAdminSessionGrant(async () => ["0xsig"], { wallet: "0xadmin", ttlSeconds: 3600, now: () => FIXED_NOW });
}

function appWith(overrides: Partial<AdminSigDeps>, _session: AdminSession) {
  const seen = new Set<string>();
  const deps: AdminSigDeps = {
    verifyWalletSignature: async () => ({ ok: true }),
    isAdmin: async () => true,
    nonceStore: { consume: async (n) => (seen.has(n) ? false : (seen.add(n), true)) },
    now: () => FIXED_NOW,
    ...overrides,
  };
  const app = new Hono();
  app.use("*", createAdminSignatureAuth(deps));
  app.get("/admin/ping", (c) => c.json({ wallet: c.get("adminWallet") }));
  app.post("/admin/echo", async (c) => c.json(await c.req.json()));
  return app;
}

function reqHeaders(session: AdminSession, method: string, path: string, body = "") {
  return encodeAdminHeaders(session, { method, path, body, now: () => FIXED_NOW });
}

test("valid signed GET passes and exposes adminWallet", async () => {
  const s = await makeSession();
  const app = appWith({}, s);
  const res = await app.request("/admin/ping", { headers: reqHeaders(s, "GET", "/admin/ping") });
  expect(res.status).toBe(200);
  expect((await res.json()).wallet).toBe("0xadmin");
});

test("POST body is bound by the signature and still readable downstream", async () => {
  const s = await makeSession();
  const app = appWith({}, s);
  const body = JSON.stringify({ x: 1 });
  const res = await app.request("/admin/echo", { method: "POST", body, headers: { ...reqHeaders(s, "POST", "/admin/echo", body), "content-type": "application/json" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ x: 1 });
});

test("non-admin → 403", async () => {
  const s = await makeSession();
  const app = appWith({ isAdmin: async () => false }, s);
  const res = await app.request("/admin/ping", { headers: reqHeaders(s, "GET", "/admin/ping") });
  expect(res.status).toBe(403);
});

test("bad wallet signature → 401", async () => {
  const s = await makeSession();
  const app = appWith({ verifyWalletSignature: async () => ({ ok: false, reason: "invalid" }) }, s);
  const res = await app.request("/admin/ping", { headers: reqHeaders(s, "GET", "/admin/ping") });
  expect(res.status).toBe(401);
});

test("replayed nonce → 401", async () => {
  const s = await makeSession();
  const app = appWith({}, s);
  const h = reqHeaders(s, "GET", "/admin/ping");
  expect((await app.request("/admin/ping", { headers: h })).status).toBe(200);
  expect((await app.request("/admin/ping", { headers: h })).status).toBe(401);
});

test("expired session → 401", async () => {
  const s = await makeSession();
  const app = appWith({ now: () => FIXED_NOW + 4_000_000 }, s); // past expiry
  const res = await app.request("/admin/ping", { headers: reqHeaders(s, "GET", "/admin/ping") });
  expect(res.status).toBe(401);
});

test("tampered path (sign A, call B) → 401", async () => {
  const s = await makeSession();
  const app = appWith({}, s);
  const h = reqHeaders(s, "GET", "/admin/other"); // signed for a different path
  const res = await app.request("/admin/ping", { headers: h });
  expect(res.status).toBe(401);
});

test("malformed headers → 400", async () => {
  const s = await makeSession();
  const app = appWith({}, s);
  const res = await app.request("/admin/ping", {}); // no admin headers
  expect(res.status).toBe(400);
});
