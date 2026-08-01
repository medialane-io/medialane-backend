import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createWalletActivityRoutes, type WalletActivityDeps } from "./wallet-activity.js";

const ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const OTHER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000999";

function makeApp(deps: WalletActivityDeps, walletAddress = ADDRESS) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("walletAddress", walletAddress);
    c.set("account", { id: "acc-1", plan: "FREE", status: "ACTIVE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/wallet-activity", createWalletActivityRoutes(deps));
  return app;
}

test("syncs then returns the caller's own activity", async () => {
  let synced = false;
  const deps: WalletActivityDeps = {
    sync: async () => { synced = true; },
    listActivity: async () => [{ id: "a1", type: "SEND", txHash: "0xtx" } as never],
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  expect(synced).toBe(true);
  const body = (await res.json()) as { data: unknown[] };
  expect(body.data).toHaveLength(1);
});

test("403s when the queried address doesn't match the authenticated wallet", async () => {
  const deps: WalletActivityDeps = { sync: async () => {}, listActivity: async () => [] };
  const app = makeApp(deps, ADDRESS);
  const res = await app.request(`/v1/wallet-activity?address=${OTHER_ADDRESS}`);
  expect(res.status).toBe(403);
});

test("400s when address is missing", async () => {
  const deps: WalletActivityDeps = { sync: async () => {}, listActivity: async () => [] };
  const app = makeApp(deps);
  const res = await app.request("/v1/wallet-activity");
  expect(res.status).toBe(400);
});
