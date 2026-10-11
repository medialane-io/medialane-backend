import { describe, expect, test } from "bun:test";
import { resolveFeeConfig, getTokenBySymbol } from "@medialane/sdk";
import { buildPopClaimIntent, buildPopBurnIntent, buildDropClaimIntent, buildDropAllowlistIntent } from "./drops.js";

const COL = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ME = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
const USDC = getTokenBySymbol("USDC")!.address;
const cfg = resolveFeeConfig({ enabled: true, fundAddress: "0x0abc", launchpadBps: 100 });

describe("POP and drop intents", () => {
  test("POP claim passes the proof", async () => {
    const { calls } = await buildPopClaimIntent({ claimer: ME, collection: COL, proof: ["0x1", "0x2"] });
    expect(calls).toEqual([{ contractAddress: COL, entrypoint: "claim", calldata: ["2", "0x1", "0x2"] }]);
  });

  test("POP burn burns one token", async () => {
    const { calls } = await buildPopBurnIntent({ owner: ME, collection: COL, tokenId: "9" });
    expect(calls).toEqual([{ contractAddress: COL, entrypoint: "burn", calldata: ["9", "0"] }]);
  });

  test("a free drop claim is one claim call", async () => {
    const read = async () => ({ price: 0n, paymentToken: "0x0" });
    const { calls } = await buildDropClaimIntent({ claimer: ME, collection: COL }, { appId: "MEDIALANE_IO" }, read, cfg);
    expect(calls).toEqual([{ contractAddress: COL, entrypoint: "claim", calldata: ["1", "0"] }]);
  });

  test("a paid drop claim approves, claims, then pays the launchpad fee", async () => {
    const read = async () => ({ price: 1_000_000n, paymentToken: USDC });
    const { calls } = await buildDropClaimIntent({ claimer: ME, collection: COL }, { appId: "MEDIALANE_IO" }, read, cfg);
    expect(calls.map((c) => c.entrypoint)).toEqual(["approve", "claim", "transfer"]);
    expect(calls[0]).toEqual({ contractAddress: USDC, entrypoint: "approve", calldata: [COL, "1000000", "0"] });
    expect(calls[2]!.calldata).toEqual(["0x0abc", "10000", "0"]);
  });

  test("a paid drop for a partner app has no fee", async () => {
    const read = async () => ({ price: 1_000_000n, paymentToken: USDC });
    const { calls } = await buildDropClaimIntent({ claimer: ME, collection: COL }, { appId: "PARTNER" }, read, cfg);
    expect(calls.map((c) => c.entrypoint)).toEqual(["approve", "claim"]);
  });

  test("a paid drop in an unlisted token is refused", async () => {
    const read = async () => ({ price: 5n, paymentToken: "0x999" });
    await expect(buildDropClaimIntent({ claimer: ME, collection: COL }, { appId: "MEDIALANE_IO" }, read, cfg)).rejects.toThrow();
  });

  test("allowlist setup enables the allowlist and adds the addresses", async () => {
    const { calls } = await buildDropAllowlistIntent({ owner: ME, collection: COL, addresses: [ME] });
    expect(calls).toEqual([
      { contractAddress: COL, entrypoint: "set_allowlist_enabled", calldata: ["1"] },
      { contractAddress: COL, entrypoint: "batch_add_to_allowlist", calldata: ["1", ME] },
    ]);
  });
});
