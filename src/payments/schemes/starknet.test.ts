import { describe, expect, test, mock } from "bun:test";

const TRANSFER_KEY = "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const TREASURY = "0x0123";

process.env.STARKNET_USDC_CONTRACT = USDC;
process.env.X402_TREASURY_ADDRESS = TREASURY;

let receipt: unknown;
mock.module("../../utils/starknet.js", () => ({
  callRpc: async (fn: (p: unknown) => Promise<unknown>) =>
    fn({ getTransactionReceipt: async () => receipt }),
  createProvider: () => ({}),
  normalizeAddress: (a: string) => a.toLowerCase().replace(/^0x0+/, "0x"),
}));

const { StarknetUsdcScheme } = await import("./starknet.js");
const scheme = new StarknetUsdcScheme();

describe("StarknetUsdcScheme.verify", () => {
  test("accepts a finalized USDC transfer to treasury ≥ required", async () => {
    receipt = {
      execution_status: "SUCCEEDED",
      finality_status: "ACCEPTED_ON_L2",
      events: [
        { from_address: USDC, keys: [TRANSFER_KEY, "0xsender", TREASURY], data: ["0xf4240", "0x0"] }, // 1_000_000 atomic
      ],
    };
    const res = await scheme.verify({ scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" });
    expect(res.ok).toBe(true);
    expect(res.amountAtomic).toBe(1_000_000n);
    expect(res.payer).toBe("0xsender");
    expect(res.proofNonce).toBe("0xtx:n1");
  });

  test("rejects when no transfer to treasury is present", async () => {
    receipt = { execution_status: "SUCCEEDED", finality_status: "ACCEPTED_ON_L2", events: [] };
    const res = await scheme.verify({ scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" });
    expect(res.ok).toBe(false);
  });

  test("rejects a reverted tx", async () => {
    receipt = { execution_status: "REVERTED", finality_status: "ACCEPTED_ON_L2", events: [] };
    const res = await scheme.verify({ scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" });
    expect(res.ok).toBe(false);
  });
});
