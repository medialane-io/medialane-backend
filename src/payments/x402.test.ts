import { describe, expect, test } from "bun:test";
import { encodePaymentHeader, decodePaymentHeader, buildPaymentRequired, settlePayment } from "./x402.js";
import type { CreditInput } from "./credits.js";
import { normalizeHash } from "../utils/starknet.js";
import { acceptedTokens } from "./token-value.js";

const USDC_ADDRESS = acceptedTokens().find((t) => t.symbol === "USDC")!.address;
const fakePrices = async () => ({ USDC: 1 });

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
  verify: async () => ({ ok: true, amountAtomic: 1_000_000n, asset: USDC_ADDRESS, payer: "0xpayer", proofNonce: normalizeHash("0xabc") }),
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
      readUsdPrices: fakePrices,
    };
    const res = await settlePayment(
      scheme,
      { id: "t1", accountId: "acc-t1" },
      { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.creditedAmount).toBe(120);
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
      readUsdPrices: fakePrices,
    };
    const res = await settlePayment(
      scheme,
      { id: "t-attacker", accountId: "acc-attacker" },
      { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not linked to this account/);
    expect(credited).toHaveLength(0);
  });

  test("rejects when verify() reports no payer at all", async () => {
    const noPayerScheme = { ...scheme, verify: async () => ({ ok: true, amountAtomic: 1_000_000n, asset: USDC_ADDRESS, proofNonce: normalizeHash("0xabc") }) };
    const deps = {
      creditAccount: async () => {},
      mdlnMultiplier: async () => 1.0,
      isWalletLinkedToAccount: async () => true,
      readUsdPrices: fakePrices,
    };
    const res = await settlePayment(
      noPayerScheme,
      { id: "t1", accountId: "acc-t1" },
      { scheme: "starknet-transfer", network: "starknet", txHash: "0xtx", nonce: "n1" },
      deps,
    );
    expect(res.ok).toBe(false);
  });
});

const ETH_ADDRESS = acceptedTokens().find((t) => t.symbol === "ETH")!.address;

function schemeReturning(amountAtomic: bigint, asset: string) {
  return {
    ...scheme,
    verify: async () => ({ ok: true, amountAtomic, asset, payer: "0xpayer", proofNonce: normalizeHash("0xabc") }),
  };
}

test("paying in ETH credits at its dollar value", async () => {
  let credited = 0;
  const res = await settlePayment(
    schemeReturning(10n ** 17n, ETH_ADDRESS),
    { id: "c1", accountId: "a1" },
    { scheme: "starknet-transfer", network: "starknet", txHash: "0xabc", nonce: "n" },
    {
      creditAccount: async (input) => { credited = input.creditedAmount; },
      mdlnMultiplier: async () => 1,
      isWalletLinkedToAccount: async () => true,
      readUsdPrices: async () => ({ ETH: 3000 }),
    },
  );
  expect(res.ok).toBe(true);
  expect(credited).toBe(30_000);
});

test("paying in USDC credits exactly as before", async () => {
  let credited = 0;
  await settlePayment(
    schemeReturning(10_000_000n, USDC_ADDRESS),
    { id: "c1", accountId: "a1" },
    { scheme: "starknet-transfer", network: "starknet", txHash: "0xabc", nonce: "n" },
    {
      creditAccount: async (input) => { credited = input.creditedAmount; },
      mdlnMultiplier: async () => 1,
      isWalletLinkedToAccount: async () => true,
      readUsdPrices: async () => ({ USDC: 1 }),
    },
  );
  expect(credited).toBe(1000);
});

test("a token with no price credits nothing rather than guessing", async () => {
  let credited: number | null = null;
  const res = await settlePayment(
    schemeReturning(10n ** 17n, ETH_ADDRESS),
    { id: "c1", accountId: "a1" },
    { scheme: "starknet-transfer", network: "starknet", txHash: "0xabc", nonce: "n" },
    {
      creditAccount: async (input) => { credited = input.creditedAmount; },
      mdlnMultiplier: async () => 1,
      isWalletLinkedToAccount: async () => true,
      readUsdPrices: async () => ({}),
    },
  );
  expect(res.ok).toBe(false);
  expect(credited).toBeNull();
});

test("an unrecognised token is refused", async () => {
  const res = await settlePayment(
    schemeReturning(1_000_000n, "0xdeadbeef"),
    { id: "c1", accountId: "a1" },
    { scheme: "starknet-transfer", network: "starknet", txHash: "0xabc", nonce: "n" },
    {
      creditAccount: async () => {},
      mdlnMultiplier: async () => 1,
      isWalletLinkedToAccount: async () => true,
      readUsdPrices: async () => ({ USDC: 1 }),
    },
  );
  expect(res.ok).toBe(false);
});
