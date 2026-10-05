import { test, expect } from "bun:test";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../types/hono.js";
import { callerApp, DEFAULT_APP } from "./caller.js";

function appWith(setup: (c: Context<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.get("/", (c) => c.json({ app: callerApp(c) }));
  return app;
}

test("the caller's app is the app the request named", async () => {
  const res = await appWith((c) => c.set("appId", "MEDIALANE_IO")).request("/");
  expect(await res.json()).toEqual({ app: "MEDIALANE_IO" });
});

test("a request that names no app is the default app", async () => {
  const res = await appWith(() => {}).request("/");
  expect(await res.json()).toEqual({ app: DEFAULT_APP });
});
