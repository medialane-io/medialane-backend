import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { normalizeAddress } from "../../utils/starknet.js";

const OWNER = normalizeAddress("STARKNET", "0xa11ce");
const PREVIOUS = normalizeAddress("STARKNET", "0xbad");
const COIN = normalizeAddress("STARKNET", "0xc0111");

const state: { caller: string; owner: string | Error } = { caller: OWNER, owner: OWNER };
const update = mock((args: { data: Record<string, unknown> }) =>
  Promise.resolve({ contractAddress: COIN, startBlock: 0n, ...args.data }),
);

mock.module("../../db/client.js", () => ({
  default: {
    coin: {
      findUnique: mock(() => Promise.resolve({ contractAddress: COIN, creator: PREVIOUS })),
      update,
    },
  },
}));
mock.module("../../chainRead/index.js", () => ({
  getCollectionOwner: mock(() =>
    state.owner instanceof Error ? Promise.reject(state.owner) : Promise.resolve(state.owner),
  ),
}));
mock.module("../middleware/identityAuth.js", () => ({
  identityAuth: async (c: { set(k: string, v: string): void }, next: () => Promise<void>) => {
    c.set("walletAddress", state.caller);
    await next();
  },
}));

async function edit(scenario: typeof state) {
  Object.assign(state, scenario);
  update.mockClear();
  const { default: coins } = await import("./coins.js");
  const app = new Hono<AppEnv>();
  app.route("/", coins);
  return app.request(`/${COIN}?chain=STARKNET`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "New description" }),
  });
}

describe("PATCH /:contract", () => {
  test("the current on-chain owner can edit", async () => {
    expect((await edit({ caller: OWNER, owner: OWNER })).status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("the recorded creator cannot edit once the coin has another owner", async () => {
    expect((await edit({ caller: PREVIOUS, owner: OWNER })).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  test("an unreadable owner refuses the edit", async () => {
    expect((await edit({ caller: OWNER, owner: new Error("rpc down") })).status).toBe(503);
    expect(update).not.toHaveBeenCalled();
  });
});
