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

import { buildDropManageIntent, buildPopManageIntent } from "./drops.js";

describe("drop and POP management intents", () => {
  test("drop management builds each owner action on the drop", async () => {
    expect((await buildDropManageIntent({ owner: ME, collection: COL, action: "allowlist_enabled", enabled: false })).calls)
      .toEqual([{ contractAddress: COL, entrypoint: "set_allowlist_enabled", calldata: ["0"] }]);
    expect((await buildDropManageIntent({ owner: ME, collection: COL, action: "allowlist_add", addresses: [ME] })).calls)
      .toEqual([{ contractAddress: COL, entrypoint: "batch_add_to_allowlist", calldata: ["1", ME] }]);
    expect((await buildDropManageIntent({ owner: ME, collection: COL, action: "allowlist_remove", address: ME })).calls)
      .toEqual([{ contractAddress: COL, entrypoint: "remove_from_allowlist", calldata: [ME] }]);
    expect((await buildDropManageIntent({ owner: ME, collection: COL, action: "withdraw_payments" })).calls)
      .toEqual([{ contractAddress: COL, entrypoint: "withdraw_payments", calldata: [] }]);
  });

  test("drop management refuses an action missing its input", async () => {
    await expect(buildDropManageIntent({ owner: ME, collection: COL, action: "allowlist_add" })).rejects.toThrow();
  });

  test("POP management issues a credential or publishes the allowlist root", async () => {
    const issued = (await buildPopManageIntent({ owner: ME, collection: COL, action: "issue", recipient: ME })).calls[0]!;
    expect(issued.entrypoint).toBe("issue");
    expect(issued.calldata[0]).toBe(ME);
    expect((await buildPopManageIntent({ owner: ME, collection: COL, action: "set_allowlist_root", root: "0xabc" })).calls)
      .toEqual([{ contractAddress: COL, entrypoint: "set_allowlist_root", calldata: ["0xabc"] }]);
  });
});
