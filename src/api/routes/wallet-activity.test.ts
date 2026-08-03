import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createWalletActivityRoutes, type WalletActivityDeps, type WalletActivityRow } from "./wallet-activity.js";

const ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const OTHER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000999";

function makeApp(deps: WalletActivityDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acc-1", plan: "FREE", status: "ACTIVE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/wallet-activity", createWalletActivityRoutes(deps));
  return app;
}

function makeRow(overrides: Partial<WalletActivityRow> = {}): WalletActivityRow {
  return {
    id: "a1", chain: "STARKNET", accountAddress: ADDRESS, type: "SEND",
    txHash: "0xtx", blockNumber: 175n, timestamp: new Date("2026-08-01T00:00:00Z"),
    tokenAddress: "0xtoken", amount: "100", counterparty: "0xother",
    tokenInAddress: null, amountIn: null, tokenOutAddress: null, amountOut: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

test("returns activity for any address — no wallet-ownership check (public on-chain data)", async () => {
  const deps: WalletActivityDeps = {
    getCursor: async () => ({ updatedAt: new Date() }),
    listActivity: async () => [makeRow()],
    enqueueSync: () => {},
  };
  const app = makeApp(deps);
  // OTHER_ADDRESS — deliberately not "the caller's own" anything, since there
  // is no identity on this route anymore. This is the point of the test.
  const res = await app.request(`/v1/wallet-activity?address=${OTHER_ADDRESS}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown[] };
  expect(body.data).toHaveLength(1);
});

test("serializes a real row (BigInt blockNumber) without throwing", async () => {
  const deps: WalletActivityDeps = {
    getCursor: async () => ({ updatedAt: new Date() }),
    listActivity: async () => [makeRow({ blockNumber: 175n })],
    enqueueSync: () => {},
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ blockNumber: string }> };
  expect(body.data[0].blockNumber).toBe("175");
});

test("400s when address is missing", async () => {
  const deps: WalletActivityDeps = {
    getCursor: async () => null,
    listActivity: async () => [],
    enqueueSync: () => {},
  };
  const app = makeApp(deps);
  const res = await app.request("/v1/wallet-activity");
  expect(res.status).toBe(400);
});

test("no cursor yet (never synced) — still returns 200 with whatever's cached (empty) and enqueues a sync", async () => {
  const enqueued: Array<{ chain: string; accountAddress: string }> = [];
  const deps: WalletActivityDeps = {
    getCursor: async () => null,
    listActivity: async () => [],
    enqueueSync: (chain, accountAddress) => { enqueued.push({ chain, accountAddress }); },
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  expect(enqueued).toEqual([{ chain: "STARKNET", accountAddress: ADDRESS }]);
});

test("stale cursor (older than 2 minutes) enqueues a refresh but still returns immediately", async () => {
  let enqueued = false;
  const staleDate = new Date(Date.now() - 3 * 60 * 1000);
  const deps: WalletActivityDeps = {
    getCursor: async () => ({ updatedAt: staleDate }),
    listActivity: async () => [makeRow()],
    enqueueSync: () => { enqueued = true; },
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  expect(enqueued).toBe(true);
});

test("fresh cursor (within 2 minutes) does not enqueue a redundant sync", async () => {
  let enqueued = false;
  const freshDate = new Date(Date.now() - 30 * 1000);
  const deps: WalletActivityDeps = {
    getCursor: async () => ({ updatedAt: freshDate }),
    listActivity: async () => [makeRow()],
    enqueueSync: () => { enqueued = true; },
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  expect(enqueued).toBe(false);
});
