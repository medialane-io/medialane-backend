import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAppId } from "./appId.js";
import { hashAppSecret } from "../../utils/appSecret.js";

const IO_SECRET = "io-secret";

function build(mode: "log" | "enforce") {
  let now = 0;
  const lookups: string[] = [];
  const apps: Record<string, string[]> = { MEDIALANE_IO: [hashAppSecret(IO_SECRET)] };
  const app = new Hono<AppEnv>();
  app.use("*", createAppId({
    mode,
    now: () => now,
    app: async (id) => { lookups.push(id); return id in apps ? { secretHashes: apps[id]! } : null; },
  }));
  app.get("/", (c) => c.json({ app: c.get("appId") }));
  return { app, lookups, apps, advance: (ms: number) => { now += ms; } };
}

const call = (app: Hono<AppEnv>, headers: Record<string, string> = {}) => app.request("/", { headers });

for (const mode of ["log", "enforce"] as const) {
  test(`${mode}: a request with no app id is the default app`, async () => {
    expect(await (await call(build(mode).app)).json()).toEqual({ app: "MEDIALANE_API" });
  });

  test(`${mode}: an unknown app id is refused`, async () => {
    const res = await call(build(mode).app, { "x-app-id": "NOPE", "x-app-secret": IO_SECRET });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_app" });
  });

  test(`${mode}: the app's secret acts as the app`, async () => {
    const res = await call(build(mode).app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": IO_SECRET });
    expect(await res.json()).toEqual({ app: "MEDIALANE_IO" });
  });
}

test("log: a missing or wrong secret is still accepted as the app", async () => {
  const { app } = build("log");
  for (const headers of [{ "x-app-id": "MEDIALANE_IO" }, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "wrong" }] as Record<string, string>[]) {
    expect(await (await call(app, headers)).json()).toEqual({ app: "MEDIALANE_IO" });
  }
});

test("enforce: a missing or wrong secret is refused with 400", async () => {
  const { app } = build("enforce");
  for (const headers of [{ "x-app-id": "MEDIALANE_IO" }, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "wrong" }] as Record<string, string>[]) {
    const res = await call(app, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_app_credentials" });
  }
});

test("an app record is cached for 60s, so a new secret is accepted within a minute", async () => {
  const { app, lookups, apps, advance } = build("enforce");
  await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": IO_SECRET });
  await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": IO_SECRET });
  expect(lookups).toEqual(["MEDIALANE_IO"]);
  apps.MEDIALANE_IO = [hashAppSecret(IO_SECRET), hashAppSecret("next")];
  expect((await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "next" })).status).toBe(400);
  advance(60_001);
  expect((await call(app, { "x-app-id": "MEDIALANE_IO", "x-app-secret": "next" })).status).toBe(200);
});
