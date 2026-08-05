import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyGate } from "./apiKeyGate.js";

// 2026-08-05: the PUBLIC_V1_PATHS bypass list was removed entirely — every
// /v1/* route requires a key now, no exceptions (see apiKeyGate.ts for why).
// These tests guard against a bypass list quietly reappearing.
describe("apiKeyGate — no path is exempt", () => {
  const previouslyExemptPaths: Array<{ method: "GET" | "POST"; path: string }> = [
    { method: "GET", path: "/v1/business/provisioning/claim/tok_1" },
    { method: "POST", path: "/v1/business/provisioning/claim/tok_1" },
    { method: "GET", path: "/v1/users/me" },
    { method: "POST", path: "/v1/users/me" },
    { method: "GET", path: "/v1/auth/siws/nonce" },
    { method: "GET", path: "/v1/username-claims/check/foo" },
    { method: "GET", path: "/v1/collection-slug-claims/check/foo" },
  ];

  for (const { method, path } of previouslyExemptPaths) {
    test(`${method} ${path} requires a key`, async () => {
      const app = new Hono<AppEnv>();
      app.use("/v1/*", apiKeyGate);
      app[method === "GET" ? "get" : "post"](path, (c) => c.json({ ok: true }));
      const res = await app.request(path, { method });
      expect(res.status).toBe(401);
    });
  }

  test("an arbitrary unmapped /v1/* path also requires a key", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.get("/v1/whatever-shows-up-next", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/whatever-shows-up-next");
    expect(res.status).toBe(401);
  });
});
