import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { portalSubject } from "./portalSubject.js";

function appWithSubject() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-key", status: "ACTIVE" });
    c.set("apiClient", { id: "client-key", accountId: "acct-key", plan: "FREE", creditBalance: 10 });
    return next();
  });
  app.use("*", portalSubject);
  app.get("/me", (c) => c.json({ apiClient: c.get("apiClient").id }));
  return app;
}

test("without a token nobody is signed in, so the app's own account is not served instead", async () => {
  const res = await appWithSubject().request("/me");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "Sign in to use the portal" });
});

test("a forged or expired token is refused rather than falling back to the key", async () => {
  const res = await appWithSubject().request("/me", {
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "Invalid or expired token" });
});
