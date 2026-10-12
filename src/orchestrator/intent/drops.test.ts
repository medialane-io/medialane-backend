import { describe, expect, test } from "bun:test";
import { resolveFeeConfig, getTokenBySymbol } from "@medialane/sdk";
import { buildPopClaimIntent, buildPopBurnIntent, buildPopManageIntent } from "./drops.js";

const COL = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ME = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
const USDC = getTokenBySymbol("USDC")!.address;
const cfg = resolveFeeConfig({ enabled: true, fundAddress: "0x0abc", launchpadBps: 100 });

describe("POP intents", () => {
  test("POP claim passes the proof", async () => {
    const { calls } = await buildPopClaimIntent({ claimer: ME, collection: COL, proof: ["0x1", "0x2"] });
    expect(calls).toEqual([{ contractAddress: COL, entrypoint: "claim", calldata: ["2", "0x1", "0x2"] }]);
  });

  test("POP burn burns one token", async () => {
    const { calls } = await buildPopBurnIntent({ owner: ME, collection: COL, tokenId: "9" });
    expect(calls).toEqual([{ contractAddress: COL, entrypoint: "burn", calldata: ["9", "0"] }]);
  });

  test("POP management issues a credential or publishes the allowlist root", async () => {
    const issued = (await buildPopManageIntent({ owner: ME, collection: COL, action: "issue", recipient: ME })).calls[0]!;
    expect(issued.entrypoint).toBe("issue");
    expect(issued.calldata[0]).toBe(ME);
    expect((await buildPopManageIntent({ owner: ME, collection: COL, action: "set_allowlist_root", root: "0xabc" })).calls)
      .toEqual([{ contractAddress: COL, entrypoint: "set_allowlist_root", calldata: ["0xabc"] }]);
  });
});

import { normalizeAddress } from "@medialane/sdk";
import { feeAmount, feeBps, type DropOnchain } from "@medialane/sdk/starknet";
import { buildDropClaimIntent as claimIntent, buildDropManageIntent as manageIntent } from "./drops.js";

const big = (xs: string[]) => xs.map((x) => BigInt(x));
const onchain = (over: Partial<DropOnchain> = {}): DropOnchain => ({
  organizer: ME, startTime: 0, endTime: 0, price: 0n, paymentToken: normalizeAddress("STARKNET", "0x0"),
  maxPerWallet: 0n, allowlistRoot: "0x0", maxSupply: 500n, totalMinted: 0n, ...over,
});
const reads = (d: DropOnchain) => async () => d;
const unread = async (): Promise<DropOnchain> => { throw new Error("must not read the chain"); };
const IO = { appId: "MEDIALANE_IO" };

describe("drop claim intent", () => {
  test("a free claim is one claim call with the quantity and the proof", async () => {
    const { calls } = await claimIntent({ claimer: ME, collection: COL, quantity: "3", proof: ["0x1", "0x2"] }, IO, reads(onchain()), cfg);
    expect(calls.map((c) => c.entrypoint)).toEqual(["claim"]);
    expect(calls[0]!.contractAddress).toBe(COL);
    expect(big(calls[0]!.calldata)).toEqual([3n, 0n, 2n, 1n, 2n]);
  });

  test("a paid claim approves price × quantity, claims, then pays the launchpad fee", async () => {
    const d = onchain({ price: 1_000_000n, paymentToken: normalizeAddress("STARKNET", USDC) });
    const { calls } = await claimIntent({ claimer: ME, collection: COL, quantity: "2" }, IO, reads(d), cfg);
    expect(calls.map((c) => c.entrypoint)).toEqual(["approve", "claim", "transfer"]);
    expect(calls[0]!.contractAddress).toBe(normalizeAddress("STARKNET", USDC));
    expect(big(calls[0]!.calldata)).toEqual([BigInt(COL), 2_000_000n, 0n]);
    expect(BigInt(calls[2]!.calldata[1]!)).toBe(20_000n);
  });

  test("the fee charged equals the fee the SDK shows the collector", async () => {
    const d = onchain({ price: 1_234_567n, paymentToken: normalizeAddress("STARKNET", USDC) });
    const { calls } = await claimIntent({ claimer: ME, collection: COL, quantity: "3" }, IO, reads(d), cfg);
    expect(BigInt(calls[2]!.calldata[1]!)).toBe(feeAmount(1_234_567n * 3n, feeBps("launchpad", cfg)));
  });

  test("a partner app's paid claim has no fee", async () => {
    const d = onchain({ price: 1_000_000n, paymentToken: normalizeAddress("STARKNET", USDC) });
    const { calls } = await claimIntent({ claimer: ME, collection: COL, quantity: "1" }, { appId: "PARTNER" }, reads(d), cfg);
    expect(calls.map((c) => c.entrypoint)).toEqual(["approve", "claim"]);
  });

  test("a paid drop in an unlisted token is refused", async () => {
    const d = onchain({ price: 5n, paymentToken: normalizeAddress("STARKNET", "0x999") });
    await expect(claimIntent({ claimer: ME, collection: COL, quantity: "1" }, IO, reads(d), cfg)).rejects.toThrow("Unknown payment token");
  });

  test("a quantity of 0 or above 50 is refused before reading the chain", async () => {
    await expect(claimIntent({ claimer: ME, collection: COL, quantity: "0" }, IO, unread, cfg)).rejects.toThrow("quantity must be between 1 and 50");
    await expect(claimIntent({ claimer: ME, collection: COL, quantity: "51" }, IO, unread, cfg)).rejects.toThrow("quantity must be between 1 and 50");
  });
});

describe("drop manage intent", () => {
  test("the organizer gifts tokens with issue", async () => {
    const { calls } = await manageIntent({ owner: ME, collection: COL, action: "issue", recipient: COL, quantity: "2" }, reads(onchain()));
    expect(calls.map((c) => c.entrypoint)).toEqual(["issue"]);
    expect(big(calls[0]!.calldata)).toEqual([BigInt(COL), 2n, 0n]);
  });

  test("the organizer publishes a new list root, or 0x0 to open the drop", async () => {
    const { calls } = await manageIntent({ owner: ME, collection: COL, action: "set_allowlist_root", root: "0x0" }, reads(onchain()));
    expect(calls.map((c) => c.entrypoint)).toEqual(["set_allowlist_root"]);
    expect(big(calls[0]!.calldata)).toEqual([0n]);
  });

  test("anyone but the organizer is refused", async () => {
    const d = onchain({ organizer: normalizeAddress("STARKNET", "0x777") });
    await expect(manageIntent({ owner: ME, collection: COL, action: "set_allowlist_root", root: "0x1" }, reads(d))).rejects.toThrow("Only the drop's organizer can manage it");
  });

  test("a gift beyond the remaining supply is refused", async () => {
    const d = onchain({ maxSupply: 10n, totalMinted: 9n });
    await expect(manageIntent({ owner: ME, collection: COL, action: "issue", recipient: COL, quantity: "2" }, reads(d))).rejects.toThrow("Not enough supply left");
  });

  test("missing inputs are refused before reading the chain", async () => {
    await expect(manageIntent({ owner: ME, collection: COL, action: "issue", quantity: "1" }, unread)).rejects.toThrow("recipient is required");
    await expect(manageIntent({ owner: ME, collection: COL, action: "issue", recipient: COL }, unread)).rejects.toThrow("quantity must be between 1 and 50");
    await expect(manageIntent({ owner: ME, collection: COL, action: "set_allowlist_root" }, unread)).rejects.toThrow("root is required");
  });
});
