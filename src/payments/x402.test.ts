import { describe, expect, test, mock } from "bun:test";

const credited: unknown[] = [];
mock.module("./credits.js", () => ({
  creditTenant: async (input: unknown) => {
    credited.push(input);
  },
  debitCredits: async () => true,
}));
mock.module("./mdln.js", () => ({ mdlnMultiplier: async () => 1.2 }));

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

const { encodePaymentHeader, decodePaymentHeader, buildPaymentRequired, settlePayment } = await import("./x402.js");

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
  test("verifies, applies MDLN multiplier, and credits", async () => {
    const res = await settlePayment(scheme, "t1", {
      scheme: "starknet-transfer",
      network: "starknet",
      txHash: "0xtx",
      nonce: "n1",
    });
    expect(res.ok).toBe(true);
    expect(res.creditedAmount).toBe(120); // 1_000_000 atomic / 10_000 per credit = 100, * 1.2
    expect(credited).toHaveLength(1);
  });
});
