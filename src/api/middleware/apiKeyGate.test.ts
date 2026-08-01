import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyGate } from "./apiKeyGate.js";

describe("apiKeyGate — business provisioning claim paths", () => {
  test("GET /v1/business/provisioning/claim/:token bypasses the API key requirement", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.get("/v1/business/provisioning/claim/:token", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/business/provisioning/claim/tok_1");
    expect(res.status).toBe(200);
  });

  test("POST /v1/business/provisioning/claim/:token bypasses the API key requirement", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.post("/v1/business/provisioning/claim/:token", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/business/provisioning/claim/tok_1", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("GET /v1/business/provisioning (list) is NOT public — still requires a key", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", apiKeyGate);
    app.get("/v1/business/provisioning", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/business/provisioning");
    expect(res.status).toBe(401);
  });
});
