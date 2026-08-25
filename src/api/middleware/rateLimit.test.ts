import { test, expect } from "bun:test";
import { Hono } from "hono";
import { apiKeyRateLimit, InMemoryRateLimitStore, type RateLimitStore } from "./rateLimit.js";
import type { AppEnv } from "../../types/hono.js";

function appWith(store: RateLimitStore, apiKeyId = "key-1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", { id: apiKeyId, status: "ACTIVE", apiClient: {} } as never);
    await next();
  });
  app.use("*", apiKeyRateLimit(store));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

test("InMemoryRateLimitStore allows requests under the limit", async () => {
  const app = appWith(new InMemoryRateLimitStore());
  const res = await app.request("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("X-RateLimit-Remaining")).toBe("2999");
});

test("a store that throws (e.g. Redis unavailable) fails open instead of 500ing", async () => {
  const throwingStore: RateLimitStore = {
    async increment() {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    },
  };
  const app = appWith(throwingStore);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
