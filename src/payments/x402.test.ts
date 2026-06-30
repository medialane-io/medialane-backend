import { describe, expect, test } from "bun:test";
import { encodePaymentHeader, decodePaymentHeader, buildPaymentRequired, settlePayment } from "./x402.js";
import type { CreditInput } from "./credits.js";

const scheme = {
  scheme: "starknet-transfer",
  network: "starknet",
  buildRequirement: (a: { amountAtomic: bigint; resource: string; nonce: string }) => ({
    scheme: "starknet-transfer",
    network: "starknet",
    asset: "0xusdc",
    maxAmountRequired: a.amountAtomic.toString(),
    payTo: "0xtreasury",
    nonce: a.nonce,
    resource: a.resource,
    description: "x",
    mimeType: "application/json" as const,
  }),
  verify: async () => ({ ok: true, amountAtomic: 1_000_000n, payer: "0xpayer", proofNonce: "0xtx:n1" }),
};

describe("X-PAYMENT header codec", () => {
  test("round-trips", () => {
    const p = { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" };
    expect(decodePaymentHeader(encodePaymentHeader(p))).toEqual(p);
  });
  test("returns null for garbage", () => {
    expect(decodePaymentHeader("not-base64-json")).toBeNull();
  });
});

describe("buildPaymentRequired", () => {
  test("produces an x402 body with accepts[]", () => {
    const body = buildPaymentRequired([scheme], { costCredits: 5, resource: "/v1/intents", nonce: "n1" });
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("starknet-transfer");
  });
});

describe("settlePayment", () => {
  test("verifies, applies MDLN multiplier, and credits when payer wallet is linked", async () => {
    const credited: CreditInput[] = [];
    const deps = {
      creditAccount: async (input: CreditInput) => {
        credited.push(input);
      },
      mdlnMultiplier: async () => 1.2,
      isWalletLinkedToAccount: async () => true,
    };
    const res = await settlePayment(
      scheme,
      "t1",
      { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.creditedAmount).toBe(120); // 1_000_000 atomic / 10_000 per credit = 100, * 1.2
    expect(credited).toHaveLength(1);
    expect(credited[0].mdlnMultiplier).toBe(1.2);
  });

  test("rejects when the verified payer wallet is not linked to the calling account", async () => {
    const credited: CreditInput[] = [];
    const deps = {
      creditAccount: async (input: CreditInput) => {
        credited.push(input);
      },
      mdlnMultiplier: async () => 1.0,
      isWalletLinkedToAccount: async () => false,
    };
    const res = await settlePayment(
      scheme,
      "attacker-account",
      { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not linked to this account/);
    expect(credited).toHaveLength(0);
  });

  test("rejects when verify() reports no payer at all", async () => {
    const noPayerScheme = { ...scheme, verify: async () => ({ ok: true, amountAtomic: 1_000_000n, proofNonce: "0xtx:n1" }) };
    const deps = {
      creditAccount: async () => {},
      mdlnMultiplier: async () => 1.0,
      isWalletLinkedToAccount: async () => true, // would link, but payer is undefined — must still reject
    };
    const res = await settlePayment(
      noPayerScheme,
      "t1",
      { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" },
      deps,
    );
    expect(res.ok).toBe(false);
  });
});
