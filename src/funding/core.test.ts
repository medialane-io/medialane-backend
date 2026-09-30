import { describe, expect, test } from "bun:test";
import {
  createIntent,
  settleIntent,
  creditsForUsdcAtomic,
  FundingError,
  INTENT_TTL_MS,
} from "./core.js";
import type { FundingIntentRecord, FundingStore, SettleInput, SettleOutcome, VerifiedPayment } from "./types.js";

function intent(over: Partial<FundingIntentRecord> = {}): FundingIntentRecord {
  return {
    id: "fi1",
    apiClientId: "ac1",
    method: "chain-transfer",
    status: "PENDING",
    payer: "0xabc",
    params: {},
    expiresAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

function store(over: Partial<FundingStore> = {}): FundingStore & { settled: SettleInput[] } {
  const settled: SettleInput[] = [];
  return {
    settled,
    create: async (i) => intent({ apiClientId: i.apiClientId, method: i.method, params: i.params, expiresAt: i.expiresAt, payer: null }),
    get: async () => null,
    setPayer: async () => true,
    openForPayer: async () => [],
    cancel: async () => true,
    settle: async (input): Promise<SettleOutcome> => {
      settled.push(input);
      return { outcome: "settled", paymentId: "pay1" };
    },
    ...over,
  };
}

const payment = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  valueUsdcAtomic: 1_000_000n,
  asset: "0xusdc",
  payer: "0xabc",
  proofNonce: "0xhash",
  scheme: "starknet-transfer",
  network: "starknet",
  txHash: "0xhash",
  ...over,
});

describe("credits for a payment", () => {
  test("one USDC is 100 credits", () => {
    expect(creditsForUsdcAtomic(1_000_000n, 1)).toBe(100);
  });
  test("the MDLN multiplier applies and rounds down", () => {
    expect(creditsForUsdcAtomic(1_000_000n, 1.5)).toBe(150);
    expect(creditsForUsdcAtomic(1_010_000n, 1.2)).toBe(121);
  });
  test("less than one credit is zero", () => {
    expect(creditsForUsdcAtomic(9_999n, 1)).toBe(0);
  });
});

describe("creating an intent", () => {
  test("it expires in 24 hours", async () => {
    const now = new Date("2026-09-29T00:00:00Z");
    const made = await createIntent(store(), { apiClientId: "ac1", method: "chain-transfer", params: {} }, now);
    expect(made.expiresAt.getTime()).toBe(now.getTime() + INTENT_TTL_MS);
  });

  test("an account can open another top-up however many it has open", async () => {
    const s = store();
    await expect(createIntent(s, { apiClientId: "ac1", method: "chain-transfer", params: {} })).resolves.toBeDefined();
  });
});

describe("settling an intent", () => {
  test("credits the intent's account from what was paid", async () => {
    const s = store();
    const result = await settleIntent({ store: s, mdlnMultiplier: async () => 1 }, intent(), payment());
    expect(result).toEqual({ ok: true, credited: 100, paymentId: "pay1" });
    expect(s.settled[0]!.credited).toBe(100);
    expect(s.settled[0]!.intent.apiClientId).toBe("ac1");
  });

  test("the payer's MDLN holding raises the credits", async () => {
    const s = store();
    const result = await settleIntent({ store: s, mdlnMultiplier: async () => 1.5 }, intent(), payment());
    expect(result).toMatchObject({ ok: true, credited: 150 });
  });

  test("an intent that is not open settles nothing", async () => {
    const s = store({ settle: async () => ({ outcome: "not-open" }) });
    const result = await settleIntent({ store: s, mdlnMultiplier: async () => 1 }, intent(), payment());
    expect(result).toEqual({ ok: false, reason: "not-open" });
  });

  test("a transfer that was already credited settles nothing", async () => {
    const s = store({ settle: async () => ({ outcome: "duplicate" }) });
    const result = await settleIntent({ store: s, mdlnMultiplier: async () => 1 }, intent(), payment());
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  test("a payment worth less than one credit is not credited", async () => {
    const s = store();
    const result = await settleIntent({ store: s, mdlnMultiplier: async () => 1 }, intent(), payment({ valueUsdcAtomic: 100n }));
    expect(result).toEqual({ ok: false, reason: "not-open" });
    expect(s.settled).toEqual([]);
  });
});

describe("FundingError", () => {
  test("carries a code", () => {
    expect(new FundingError("not_found", "x").code).toBe("not_found");
  });
});
