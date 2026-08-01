import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createWalletActivityRoutes, type WalletActivityDeps, type WalletActivityRow } from "./wallet-activity.js";

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

// Full, real-shaped row (matches WalletActivityRow exactly) — deliberately no
// `as never` escape hatch, so an incomplete fixture is a type error, not a
// silent gap. This is what let the BigInt-serialization bug through the first
// time: the old fixture only had 3 of 15 fields and was cast past the type
// checker instead of built to match the real shape.
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

test("syncs then returns the caller's own activity", async () => {
  let synced = false;
  const deps: WalletActivityDeps = {
    sync: async () => { synced = true; },
    listActivity: async () => [makeRow()],
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  expect(synced).toBe(true);
  const body = (await res.json()) as { data: unknown[] };
  expect(body.data).toHaveLength(1);
});

test("serializes a real row (BigInt blockNumber) without throwing", async () => {
  const deps: WalletActivityDeps = {
    sync: async () => {},
    listActivity: async () => [makeRow({ blockNumber: 175n })],
  };
  const app = makeApp(deps);
  const res = await app.request(`/v1/wallet-activity?address=${ADDRESS}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ blockNumber: string }> };
  expect(body.data[0].blockNumber).toBe("175");
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
