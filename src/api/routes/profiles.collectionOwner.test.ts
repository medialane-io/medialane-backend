import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import * as realStarknet from "../../utils/starknet.js";

const CONTRACT = realStarknet.normalizeAddress("STARKNET", "0xc0de");
const OWNER = realStarknet.normalizeAddress("STARKNET", "0xa11ce");
const PREVIOUS = realStarknet.normalizeAddress("STARKNET", "0xbad");

type Scenario = { caller: string; owner: string | Error };
const state: Scenario = { caller: OWNER, owner: OWNER };
const upsert = mock(() => Promise.resolve({ displayName: "New name" }));

mock.module("../../db/client.js", () => ({
  default: {
    collection: {
      findUnique: mock(() => Promise.resolve({ contractAddress: CONTRACT })),
    },
    collectionProfile: { upsert, findUnique: mock(() => Promise.resolve(null)) },
  },
}));
mock.module("../../chainRead/index.js", () => ({
  holdsToken: mock(() => Promise.resolve(false)),
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

async function setup(opts: Scenario) {
  Object.assign(state, opts);
  upsert.mockClear();
  const { default: profiles } = await import("./profiles.js");
  const app = new Hono<AppEnv>();
  app.route("/", profiles);
  const edit = () =>
    app.request(`/collections/${CONTRACT}/profile?chain=STARKNET`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "New name" }),
    });
  return { edit, upsert };
}

describe("PATCH /collections/:contract/profile", () => {
  test("the current on-chain owner can edit", async () => {
    const { edit, upsert } = await setup({ caller: OWNER, owner: OWNER });
    const res = await edit();
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test("a previous owner cannot edit after the collection moved", async () => {
    const { edit, upsert } = await setup({ caller: PREVIOUS, owner: OWNER });
    const res = await edit();
    expect(res.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  test("an unreadable owner refuses the edit", async () => {
    const { edit, upsert } = await setup({ caller: OWNER, owner: new Error("rpc down") });
    const res = await edit();
    expect(res.status).toBe(503);
    expect(upsert).not.toHaveBeenCalled();
  });
});
