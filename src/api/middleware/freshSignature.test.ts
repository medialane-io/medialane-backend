import { test, expect } from "bun:test";
import { FRESH_SIGNATURE_SECONDS, isFresh } from "./freshSignature.js";

const NOW = 1_700_000_000;

test("a signature made moments ago is fresh", () => {
  expect(isFresh(NOW, NOW)).toBe(true);
  expect(isFresh(NOW - 30, NOW)).toBe(true);
});

test("a signature is fresh right up to the limit and not past it", () => {
  expect(isFresh(NOW - FRESH_SIGNATURE_SECONDS, NOW)).toBe(true);
  expect(isFresh(NOW - FRESH_SIGNATURE_SECONDS - 1, NOW)).toBe(false);
});

test("a token stolen hours ago cannot mint anything", () => {
  expect(isFresh(NOW - 3600, NOW)).toBe(false);
  expect(isFresh(NOW - 23 * 3600, NOW)).toBe(false);
});

test("a timestamp from the future is not accepted as fresh", () => {
  expect(isFresh(NOW + 3600, NOW)).toBe(false);
});

test("small clock skew is tolerated", () => {
  expect(isFresh(NOW + 30, NOW)).toBe(true);
});

test("a subject with no recorded sign-in time cannot mint a key", async () => {
  const { Hono } = await import("hono");
  type Env = import("../../types/hono.js").AppEnv;
  const { freshSignature } = await import("./freshSignature.js");

  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-1", status: "ACTIVE" });
    return next();
  });
  app.use("*", freshSignature);
  app.post("/keys", (c) => c.json({ minted: true }));

  const res = await app.request("/keys", { method: "POST" });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: "stale_signature" });
});

test("a recent sign-in is enough, whichever kind it was", async () => {
  const { Hono } = await import("hono");
  type Env = import("../../types/hono.js").AppEnv;
  const { freshSignature } = await import("./freshSignature.js");

  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-1", status: "ACTIVE" });
    c.set("subjectTokenIssuedAt", Math.floor(Date.now() / 1000) - 5);
    return next();
  });
  app.use("*", freshSignature);
  app.post("/keys", (c) => c.json({ minted: true }));

  const res = await app.request("/keys", { method: "POST" });
  expect(res.status).toBe(200);
});
