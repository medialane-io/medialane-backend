import { describe, expect, test } from "bun:test";

import { parseUsdcTransfer, type StarknetReceipt } from "./starknet.js";
import { normalizeAddress, normalizeHash } from "../../utils/starknet.js";

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
        { from_address: USDC, keys: [TRANSFER_KEY, SENDER, TREASURY], data: ["0xf4240", "0x0"] },
      ],
    };
    const res = parseUsdcTransfer(receipt, params);
    expect(res.ok).toBe(true);
    expect(res.amountAtomic).toBe(1_000_000n);
    expect(res.payer).toBe(normalizeAddress("STARKNET", SENDER));
    expect(res.proofNonce).toBe("0xtx");
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

describe("StarknetUsdcScheme.verify — replay safety", () => {
  const TX = "0x07ab3f9c2e1d5a8b4c6d0e2f1a3b5c7d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b";
  const receipt: StarknetReceipt = {
    execution_status: "SUCCEEDED",
    finality_status: "ACCEPTED_ON_L2",
    events: [
      { from_address: USDC, keys: [TRANSFER_KEY, SENDER, TREASURY], data: ["0xf4240", "0x0"] },
    ],
  };

  // proofNonce carries the @unique constraint that stops one on-chain payment
  // crediting an account twice. A felt hash has many equal spellings, so every
  // spelling of the same tx must collapse to one proofNonce — otherwise a
  // single real payment can be settled once per spelling.
  test("equal spellings of one tx hash all produce the same proofNonce", () => {
    const spellings = [
      TX,
      TX.replace(/^0x0/, "0x"),
      "0x" + TX.slice(2).toUpperCase(),
    ];

    const nonces = spellings.map(
      (txHash) => parseUsdcTransfer(receipt, { ...params, txHash: normalizeHash(txHash) }).proofNonce,
    );

    expect(new Set(nonces).size).toBe(1);
  });

  test("normalizeHash rejects a non-felt transaction hash", () => {
    expect(() => normalizeHash("not-a-hash")).toThrow();
  });
});

