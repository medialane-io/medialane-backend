import { test, expect } from "bun:test";
import { Hono } from "hono";
import { clientIpRateLimit } from "./clientIpRateLimit.js";
import { InMemoryRateLimitStore, type RateLimitStore } from "./rateLimit.js";
import type { AppEnv } from "../../types/hono.js";

function appWith(store: RateLimitStore, max = 2) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", { id: "key_1" } as never);
    return next();
  });
  app.use("*", clientIpRateLimit(store, max));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

const withIp = (ip: string) => ({ headers: { "x-medialane-client-ip": ip } });

test("a single end user is capped even though the app key is shared", async () => {
  const app = appWith(new InMemoryRateLimitStore());
  expect((await app.request("/", withIp("1.1.1.1"))).status).toBe(200);
  expect((await app.request("/", withIp("1.1.1.1"))).status).toBe(200);
  expect((await app.request("/", withIp("1.1.1.1"))).status).toBe(429);
});

test("one user hitting the cap does not affect another", async () => {
  const app = appWith(new InMemoryRateLimitStore());
  await app.request("/", withIp("1.1.1.1"));
  await app.request("/", withIp("1.1.1.1"));
  expect((await app.request("/", withIp("1.1.1.1"))).status).toBe(429);
  expect((await app.request("/", withIp("2.2.2.2"))).status).toBe(200);
});

test("a direct API consumer is not per-IP limited, since one server IP is legitimate", async () => {
  const app = appWith(new InMemoryRateLimitStore());
  for (let i = 0; i < 5; i++) {
    expect((await app.request("/")).status).toBe(200);
  }
});

test("counting is per app key, so one app cannot exhaust another's budget for the same user", async () => {
  const store = new InMemoryRateLimitStore();
  const appA = appWith(store);
  const appB = new Hono<AppEnv>();
  appB.use("*", async (c, next) => { c.set("apiKey", { id: "key_2" } as never); return next(); });
  appB.use("*", clientIpRateLimit(store, 2));
  appB.get("/", (c) => c.json({ ok: true }));

  await appA.request("/", withIp("1.1.1.1"));
  await appA.request("/", withIp("1.1.1.1"));
  expect((await appA.request("/", withIp("1.1.1.1"))).status).toBe(429);
  expect((await appB.request("/", withIp("1.1.1.1"))).status).toBe(200);
});

test("an unavailable store allows the request rather than failing the app closed", async () => {
  const broken: RateLimitStore = { increment: async () => { throw new Error("redis down"); } };
  const app = appWith(broken);
  expect((await app.request("/", withIp("1.1.1.1"))).status).toBe(200);
});

test("the default cap leaves room for many users behind one NAT address", async () => {
  // A venue or carrier NAT presents a crowd as a single address. The cap has to
  // sit above plausible legitimate burst from that crowd, not above one person.
  const { clientIpRateLimit: withDefault } = await import("./clientIpRateLimit.js");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("apiKey", { id: "key_1" } as never); return next(); });
  app.use("*", withDefault(new InMemoryRateLimitStore()));
  app.get("/", (c) => c.json({ ok: true }));

  // 40 concurrent users behind one address, 20 requests each in the window.
  for (let i = 0; i < 800; i++) {
    expect((await app.request("/", withIp("203.0.113.1"))).status).toBe(200);
  }
});
