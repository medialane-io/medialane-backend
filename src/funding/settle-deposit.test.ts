import { describe, expect, test } from "bun:test";
import { intentSettler } from "./settle-deposit.js";
import type { DepositEvent } from "./deposits.js";
import type { FundingIntentRecord, FundingStore, SettleInput } from "./types.js";

const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";

const intent = (id: string, amount: string, over: Partial<FundingIntentRecord> = {}): FundingIntentRecord => ({
  id, apiClientId: `client-${id}`, method: "chain-transfer", status: "PENDING", payer: "0x0c9",
  params: { amountAtomic: amount }, expiresAt: new Date(), ...over,
});

const deposit = (over: Partial<DepositEvent> = {}): DepositEvent => ({
  txHash: "0xabc", token: USDC, amountAtomic: 5_000_000n, payer: "0x0c9", blockNumber: 1, depositIndex: 0, ...over,
});

function store(open: FundingIntentRecord[]) {
  const settled: SettleInput[] = [];
  const s: FundingStore = {
    countOpen: async () => 0, create: async () => open[0]!, get: async () => null, setPayer: async () => true,
    openForPayer: async () => open,
    settle: async (input) => { settled.push(input); return { outcome: "settled", paymentId: `pay-${input.intent.id}` }; },
  };
  return { s, settled };
}

describe("settling a scanned deposit against open intents", () => {
  test("credits the intent's account, not the payer's own", async () => {
    const { s, settled } = store([intent("a", "5000000")]);
    const result = await intentSettler({ store: s, mdlnMultiplier: async () => 1 })(deposit(), "0xabc");
    expect(result).toEqual({ paymentId: "pay-a", apiClientId: "client-a" });
    expect(settled[0]!.credited).toBe(500);
  });

  test("with several open intents, settles the oldest one the transfer satisfies", async () => {
    const { s, settled } = store([intent("big", "9000000"), intent("first", "5000000"), intent("second", "1000000")]);
    await intentSettler({ store: s, mdlnMultiplier: async () => 1 })(deposit(), "0xabc");
    expect(settled.map((x) => x.intent.id)).toEqual(["first"]);
  });

  test("a transfer that satisfies nothing returns null so the legacy path can decide", async () => {
    const { s, settled } = store([intent("big", "9000000")]);
    expect(await intentSettler({ store: s, mdlnMultiplier: async () => 1 })(deposit(), "0xabc")).toBeNull();
    expect(settled).toEqual([]);
  });

  test("a transfer already counted returns null", async () => {
    const { s } = store([intent("a", "5000000")]);
    s.settle = async () => ({ outcome: "duplicate" });
    expect(await intentSettler({ store: s, mdlnMultiplier: async () => 1 })(deposit(), "0xabc")).toBeNull();
  });

  test("uses the nonce it is given as the payment reference", async () => {
    const { s, settled } = store([intent("a", "5000000")]);
    await intentSettler({ store: s, mdlnMultiplier: async () => 1 })(deposit({ depositIndex: 1 }), "0xabc:1");
    expect(settled[0]!.verified.proofNonce).toBe("0xabc:1");
  });
});
