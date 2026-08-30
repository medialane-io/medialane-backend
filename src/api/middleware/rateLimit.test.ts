import { test, expect } from "bun:test";
import { Hono } from "hono";
import { apiKeyRateLimit, InMemoryRateLimitStore, type RateLimitStore, FallbackRateLimitStore } from "./rateLimit.js";
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

test("a store failing past the fallback allows rather than 500ing, which is the last resort not the norm", async () => {
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

test("a failing shared store degrades to per-instance counting instead of no limit", async () => {
  const broken: RateLimitStore = {
    increment: async () => { throw new Error("redis down"); },
  };
  const store = new FallbackRateLimitStore(broken);

  const first = await store.increment("k", 60_000);
  const second = await store.increment("k", 60_000);

  expect(first.count).toBe(1);
  expect(second.count).toBe(2);
});

test("the fallback keeps separate counts per key", async () => {
  const broken: RateLimitStore = {
    increment: async () => { throw new Error("redis down"); },
  };
  const store = new FallbackRateLimitStore(broken);

  await store.increment("a", 60_000);
  const b = await store.increment("b", 60_000);

  expect(b.count).toBe(1);
});
