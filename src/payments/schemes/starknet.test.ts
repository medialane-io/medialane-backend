import { describe, expect, test } from "bun:test";
// env preloaded via bunfig.toml → importing the scheme (which loads
// utils/starknet → env) is safe. We test the pure receipt parser directly,
// so no RPC mock is needed.
import { parseUsdcTransfer, type StarknetReceipt } from "./starknet.js";
import { normalizeAddress } from "../../utils/starknet.js";

const TRANSFER_KEY = "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const TREASURY = "0x123";
const SENDER = "0xabc";
const params = { usdc: USDC, treasury: TREASURY, txHash: "0xtx", nonce: "n1" };

describe("parseUsdcTransfer", () => {
  test("accepts a finalized USDC transfer to treasury ≥ required", () => {
    const receipt: StarknetReceipt = {
      execution_status: "SUCCEEDED",
      finality_status: "ACCEPTED_ON_L2",
      events: [
        { from_address: USDC, keys: [TRANSFER_KEY, SENDER, TREASURY], data: ["0xf4240", "0x0"] }, // 1_000_000 atomic
      ],
    };
    const res = parseUsdcTransfer(receipt, params);
    expect(res.ok).toBe(true);
    expect(res.amountAtomic).toBe(1_000_000n);
    expect(res.payer).toBe(normalizeAddress(SENDER));
    expect(res.proofNonce).toBe("0xtx:n1");
  });

  test("rejects when no transfer to treasury is present", () => {
    const receipt: StarknetReceipt = { execution_status: "SUCCEEDED", events: [] };
    expect(parseUsdcTransfer(receipt, params).ok).toBe(false);
  });

  test("rejects a reverted tx", () => {
    const receipt: StarknetReceipt = { execution_status: "REVERTED", events: [] };
    expect(parseUsdcTransfer(receipt, params).ok).toBe(false);
  });

  test("ignores a transfer to a different recipient", () => {
    const receipt: StarknetReceipt = {
      execution_status: "SUCCEEDED",
      events: [{ from_address: USDC, keys: [TRANSFER_KEY, SENDER, "0x9999"], data: ["0xf4240", "0x0"] }],
    };
    expect(parseUsdcTransfer(receipt, params).ok).toBe(false);
  });
});
