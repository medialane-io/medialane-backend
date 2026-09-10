import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { composeMiddleware } from "./apiKeyGate.js";

const passthrough: MiddlewareHandler = async (_c, next) => { await next(); };
const respondsWith = (status: 401 | 402 | 429): MiddlewareHandler =>
  async (c) => c.json({ error: "blocked" }, status);

function app(handlers: MiddlewareHandler[]) {
  const a = new Hono();
  a.use("/v1/*", composeMiddleware(handlers));
  a.onError((_err, c) => c.json({ error: "Internal server error" }, 500));
  a.get("/v1/thing", async (c) => c.json({ data: [] }));
  return a;
}

test("a rate limited request returns 429 rather than 500", async () => {
  const res = await app([passthrough, respondsWith(429), passthrough]).request("/v1/thing");
  expect(res.status).toBe(429);
});

test("an unauthenticated request returns 401 rather than 500", async () => {
  const res = await app([respondsWith(401), passthrough]).request("/v1/thing");
  expect(res.status).toBe(401);
});

test("a payment required response survives the gate", async () => {
  const res = await app([passthrough, passthrough, respondsWith(402)]).request("/v1/thing");
  expect(res.status).toBe(402);
});

test("the blocking middleware's body reaches the caller", async () => {
  const res = await app([passthrough, respondsWith(429)]).request("/v1/thing");
  expect(await res.json()).toEqual({ error: "blocked" });
});

test("a request that passes every middleware reaches the handler", async () => {
  const res = await app([passthrough, passthrough, passthrough]).request("/v1/thing");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: [] });
});

test("middleware after the handler still observes the response", async () => {
  let seen = 0;
  const observer: MiddlewareHandler = async (c, next) => {
    await next();
    seen = c.res.status;
  };
  const res = await app([observer, passthrough]).request("/v1/thing");
  expect(res.status).toBe(200);
  expect(seen).toBe(200);
});

test("an empty gate still reaches the handler", async () => {
  const res = await app([]).request("/v1/thing");
  expect(res.status).toBe(200);
});
