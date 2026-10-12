import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAppAccess } from "./appAccess.js";

function build(verdicts: Record<string, "ok" | "inactive">) {
  const app = new Hono<AppEnv>();
  app.use("/v1/*", async (c, next) => {
    c.set("appId", c.req.header("x-app-id") ?? "MEDIALANE_API");
    return next();
  });
  app.use("/v1/*", createAppAccess({ session: async (raw) => verdicts[raw] ?? "invalid" }));
  app.all("/v1/*", (c) => c.json({ ok: true }));
  return app;
}

const io = (extra: Record<string, string> = {}) => ({ "x-app-id": "MEDIALANE_IO", ...extra });

describe("app access", () => {
  const app = build({ good: "ok", gone: "inactive" });

  test("an app request without a session to a closed route is refused", async () => {
    const res = await app.request("/v1/metadata/upload-file", { method: "POST", headers: io() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to continue", code: "sign_in_required" });
  });

  test("the same route is open with a session", async () => {
    const res = await app.request("/v1/metadata/upload-file", { method: "POST", headers: io({ "x-account-session": "good" }) });
    expect(res.status).toBe(200);
  });

  test("a forged or expired session is refused", async () => {
    const res = await app.request("/v1/intents/listing", { method: "POST", headers: io({ "x-account-session": "nope" }) });
    expect(res.status).toBe(401);
  });

  test("an inactive account is refused", async () => {
    const res = await app.request("/v1/rpc", { method: "POST", headers: io({ "x-account-session": "gone" }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Account is not active", code: "account_inactive" });
  });

  test("a public route is open without a session", async () => {
    expect((await app.request("/v1/collections?page=2", { headers: io() })).status).toBe(200);
    expect((await app.request(`/v1/drops/0x${"d".repeat(64)}/state`, { headers: io() })).status).toBe(200);
    expect((await app.request("/v1/auth/email/register-account", { method: "POST", headers: io() })).status).toBe(200);
  });

  test("a request without an app id is untouched", async () => {
    expect((await app.request("/v1/metadata/upload-file", { method: "POST" })).status).toBe(200);
    expect((await app.request("/v1/rpc", { method: "POST" })).status).toBe(200);
  });
});
