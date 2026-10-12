import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createChainReadRoutes } from "./chain-reads.js";

const COIN = "0x" + "c".repeat(64);
const POP = "0x" + "d".repeat(64);

function build(results: Record<string, string[]>) {
  const calls: string[] = [];
  const provider = {
    callContract: async ({ entrypoint }: { entrypoint: string }) => {
      calls.push(entrypoint);
      const r = results[entrypoint];
      if (!r) throw new Error("no such entrypoint");
      return r;
    },
  };
  const app = new Hono<AppEnv>();
  app.route("/v1", createChainReadRoutes(() => provider as never));
  return { app, calls };
}

describe("chain reads", () => {
  test("coin guarantees are read from the coin contract", async () => {
    const { app } = build({
      is_launched: ["0x1"],
      get_team_allocation: ["0x64", "0x0"],
      total_supply: ["0x3e8", "0x0"],
      launched_at_block_number: ["0xa"],
      liquidity_type: ["0x1"],
    });
    const res = await app.request(`/v1/coins/${COIN}/guarantees`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ isLaunched: true, launchedAtBlock: 10, teamAllocationPercent: 10 });
  });

  test("a contract that is not a creator coin gives null", async () => {
    const { app } = build({});
    const res = await app.request(`/v1/coins/${COIN}/guarantees`);
    expect(await res.json()).toEqual({ data: null });
  });

  test("POP claim info is read from the collection", async () => {
    const { app } = build({ allowlist_root: ["0x5"], claim_end_time: ["0x64"] });
    const res = await app.request(`/v1/pop/${POP}/claim-info`);
    expect(await res.json()).toEqual({ data: { root: "0x5", claimEndTime: 100 } });
  });

  test("a POP read that fails gives null", async () => {
    const { app } = build({});
    const res = await app.request(`/v1/pop/${POP}/claim-info`);
    expect(await res.json()).toEqual({ data: null });
  });

  test("a drop's terms and supply are read from the drop contract, amounts as strings", async () => {
    const DROP = "0x" + "e".repeat(64);
    const { app } = build({
      organizer: ["0x1"],
      terms: ["0x64", "0xc8", "0x5", "0x0", "0x2", "0x3", "0x0"],
      allowlist_root: ["0x0"],
      max_supply: ["0xa", "0x0"],
      total_minted: ["0x4", "0x0"],
    });
    const res = await app.request(`/v1/drops/${DROP}/state`);
    expect((await res.json()).data).toMatchObject({
      startTime: 100,
      endTime: 200,
      price: "5",
      maxPerWallet: "3",
      allowlistRoot: "0x0",
      maxSupply: "10",
      totalMinted: "4",
    });
  });

  test("a drop read that fails gives null", async () => {
    const { app } = build({});
    const res = await app.request(`/v1/drops/${POP}/state`);
    expect(await res.json()).toEqual({ data: null });
  });
});
