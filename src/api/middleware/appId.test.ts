import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAppId } from "./appId.js";

function build(known: string[]) {
  const lookups: string[] = [];
  const app = new Hono<AppEnv>();
  app.use("*", createAppId({ exists: async (id) => { lookups.push(id); return known.includes(id); } }));
  app.get("/", (c) => c.json({ app: c.get("appId") }));
  return { app, lookups };
}

test("a request with no app id is the default app", async () => {
  const { app } = build([]);
  const res = await app.request("/");
  expect(await res.json()).toEqual({ app: "MEDIALANE_API" });
});

test("a known app id is accepted and looked up once", async () => {
  const { app, lookups } = build(["MEDIALANE_IO"]);
  for (let i = 0; i < 2; i++) {
    const res = await app.request("/", { headers: { "x-app-id": "MEDIALANE_IO" } });
    expect(await res.json()).toEqual({ app: "MEDIALANE_IO" });
  }
  expect(lookups).toEqual(["MEDIALANE_IO"]);
});

test("an unknown app id is refused", async () => {
  const { app } = build(["MEDIALANE_IO"]);
  const res = await app.request("/", { headers: { "x-app-id": "NOPE" } });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "unknown_app" });
});
