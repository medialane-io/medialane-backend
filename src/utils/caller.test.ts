import { test, expect } from "bun:test";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../types/hono.js";
import { callerClientId } from "./caller.js";

function appWith(setup: (c: Context<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.get("/", (c) => c.json({ client: callerClientId(c) }));
  return app;
}

const key = (clientId: string) => ({
  id: "key-1",
  status: "ACTIVE" as const,
  apiClient: { id: clientId, accountId: "acc-1", plan: "FREE" as const, creditBalance: 0, account: { id: "acc-1", status: "ACTIVE" as const } },
});

test("the caller's client is the client behind its API key", async () => {
  const res = await appWith((c) => c.set("apiKey", key("client-1") as never)).request("/");
  expect(await res.json()).toEqual({ client: "client-1" });
});

test("a request with no key has no client", async () => {
  const res = await appWith(() => {}).request("/");
  expect(await res.json()).toEqual({ client: null });
});

test("the signed-in subject's client does not change the caller's client", async () => {
  const res = await appWith((c) => {
    c.set("apiKey", key("client-1") as never);
    c.set("apiClient", { id: "business-9", accountId: "acc-9", plan: "FREE", creditBalance: 0 } as never);
  }).request("/");
  expect(await res.json()).toEqual({ client: "client-1" });
});
