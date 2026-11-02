import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAppId } from "./appId.js";
import { hashAppSecret } from "../../utils/appSecret.js";

const IO_SECRET = "io-secret";

function build() {
  let now = 0;
  const lookups: string[] = [];
  const apps: Record<string, string[]> = { MEDIALANE_IO: [hashAppSecret(IO_SECRET)] };
  const app = new Hono<AppEnv>();
  app.use("*", createAppId({
    now: () => now,
    app: async (id) => { lookups.push(id); return id in apps ? { secretHashes: apps[id]! } : null; },
  }));
  app.get("/", (c) => c.json({ app: c.get("appId") }));
  return { app, lookups, apps, advance: (ms: number) => { now += ms; } };
}

const call = (app: Hono<AppEnv>, headers: Record<string, string> = {}) => app.request("/", { headers });

test("a request with no app id is the default app and needs no secret", async () => {
  expect(await (await call(build().app)).json()).toEqual({ app: "MEDIALANE_API" });
});

test("an unknown app id is refused", async () => {
  const res = await call(build().app, { "x-app-id": "NOPE", "x-app-secret": IO_SECRET });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "unknown_app" });
});

test("the app's secret acts as the app", async () => {
  const res = await call(build().app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": IO_SECRET });
  expect(await res.json()).toEqual({ app: "MEDIALANE_IO" });
});

test("a missing or wrong secret is refused with 400", async () => {
  const { app } = build();
  for (const headers of [{ "x-app-id": "MEDIALANE_IO" }, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "wrong" }] as Record<string, string>[]) {
    const res = await call(app, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_app_credentials" });
  }
});

test("an app record is cached for 60s, so a new secret is accepted within a minute", async () => {
  const { app, lookups, apps, advance } = build();
  await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": IO_SECRET });
  await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": IO_SECRET });
  expect(lookups).toEqual(["MEDIALANE_IO"]);
  apps.MEDIALANE_IO = [hashAppSecret(IO_SECRET), hashAppSecret("next")];
  expect((await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "next" })).status).toBe(400);
  advance(60_001);
  expect((await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "next" })).status).toBe(200);
});
