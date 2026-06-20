import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminOrPortalAccountAuth } from "./adminSecretAuth.js";
import { env } from "../../config/env.js";

// Read the resolved values — .env (real API_SECRET_KEY) wins over the test
// preload's placeholder, so hardcoding would be brittle.
const MASTER = env.API_SECRET_KEY;
const PORTAL = env.PORTAL_SERVICE_SECRET!;

function app() {
  const a = new Hono();
  a.use("*", adminOrPortalAccountAuth);
  a.get("/admin/accounts/x", (c) => c.json({ ok: true }));
  a.get("/admin/tenants", (c) => c.json({ ok: true }));
  return a;
}

function req(path: string, key?: string) {
  return app().request(path, key ? { headers: { "x-api-key": key } } : undefined);
}

describe("adminOrPortalAccountAuth", () => {
  test("master key works on account routes", async () => {
    expect((await req("/admin/accounts/x", MASTER)).status).toBe(200);
  });
  test("master key works on non-account admin routes", async () => {
    expect((await req("/admin/tenants", MASTER)).status).toBe(200);
  });
  test("portal secret works on account routes", async () => {
    expect((await req("/admin/accounts/x", PORTAL)).status).toBe(200);
  });
  test("portal secret is REJECTED on non-account admin routes", async () => {
    expect((await req("/admin/tenants", PORTAL)).status).toBe(401);
  });
  test("wrong key is rejected everywhere", async () => {
    expect((await req("/admin/accounts/x", "nope")).status).toBe(401);
    expect((await req("/admin/tenants", "nope")).status).toBe(401);
  });
  test("missing key is rejected", async () => {
    expect((await req("/admin/accounts/x")).status).toBe(401);
  });
});
