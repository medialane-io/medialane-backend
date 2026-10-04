import { describe, expect, test } from "bun:test";
import { intentSettler } from "./settle-deposit.js";
import { tokenBySymbol, type PriceReader } from "./methods/assets.js";
import type { DepositEvent } from "./deposits.js";
import type { FundingIntentRecord, FundingStore, SettleInput } from "./types.js";

const USDC = tokenBySymbol("USDC")!.address;
const ETH = tokenBySymbol("ETH")!.address;
const prices = async () => ({ USDC: 1, USDT: 1, ETH: 2000, STRK: 0.05 });
const noPrices = async () => null;

const intent = (id: string, over: Partial<FundingIntentRecord> = {}): FundingIntentRecord => ({
  id, apiClientId: `client-${id}`, method: "chain-transfer", status: "PENDING", payer: "0x0c9",
  params: { chain: "STARKNET", asset: "USDC" }, expiresAt: new Date(), ...over,
});

const deposit = (over: Partial<DepositEvent> = {}): DepositEvent => ({
  txHash: "0xabc", token: USDC, amountAtomic: 5_000_000n, payer: "0x0c9", blockNumber: 1, depositIndex: 0, ...over,
});

function store(open: FundingIntentRecord[]) {
  const settled: SettleInput[] = [];
  const s: FundingStore = {
    create: async () => open[0]!, get: async () => null, setPayer: async () => true,
    openForPayer: async () => open,
    cancel: async () => true,
    settle: async (input) => { settled.push(input); return { outcome: "settled", paymentId: `pay-${input.intent.id}` }; },
  };
  return { s, settled };
}

const settler = (s: FundingStore, readUsdPrices: PriceReader = prices) => intentSettler({ store: s, mdlnMultiplier: async () => 1, readUsdPrices });

describe("settling a scanned deposit against open top-ups", () => {
  test("credits the top-up's account, not the payer's own, for whatever amount arrived", async () => {
    const { s, settled } = store([intent("a")]);
    expect(await settler(s)(deposit(), "0xabc")).toEqual({ paymentId: "pay-a", apiClientId: "client-a" });
    expect(settled[0]!.credited).toBe(500);
  });

  test("an amount well above or below what was suggested is credited at its value", async () => {
    const { s, settled } = store([intent("a", { params: { chain: "STARKNET", asset: "USDC", suggestedUsdAtomic: "5000000" } })]);
    await settler(s)(deposit({ amountAtomic: 20_000_000n }), "0xabc");
    await settler(s)(deposit({ amountAtomic: 30_000n, txHash: "0xdef" }), "0xdef");
    expect(settled.map((x) => x.credited)).toEqual([2000, 3]);
  });

  test("ETH is credited at its dollar value", async () => {
    const { s, settled } = store([intent("a")]);
    await settler(s)(deposit({ token: ETH, amountAtomic: 2_500_000_000_000_000n }), "0xabc");
    expect(settled[0]!.credited).toBe(500);
    expect(settled[0]!.verified.valueUsdcAtomic).toBe(5_000_000n);
  });

  test("with several open top-ups from the same wallet, the oldest is settled", async () => {
    const { s, settled } = store([intent("first"), intent("second")]);
    await settler(s)(deposit(), "0xabc");
    expect(settled.map((x) => x.intent.id)).toEqual(["first"]);
  });

  test("a transfer worth less than one credit, or of an unsupported token, is left to the legacy path", async () => {
    const { s, settled } = store([intent("a")]);
    expect(await settler(s)(deposit({ amountAtomic: 9_999n }), "0xabc")).toBeNull();
    expect(await settler(s)(deposit({ token: "0xdead" }), "0xabc")).toBeNull();
    expect(settled).toEqual([]);
  });

  test("a deposit from a wallet with no open top-up is left to the legacy path", async () => {
    const { s } = store([]);
    expect(await settler(s)(deposit(), "0xabc")).toBeNull();
  });

  test("an ETH deposit that cannot be priced stops the scan so it is retried, and is never credited elsewhere", async () => {
    const { s, settled } = store([intent("a")]);
    await expect(settler(s, noPrices)(deposit({ token: ETH, amountAtomic: 2_500_000_000_000_000n }), "0xabc")).rejects.toThrow("retrying");
    expect(settled).toEqual([]);
  });

  test("a transfer already counted returns null", async () => {
    const { s } = store([intent("a")]);
    s.settle = async () => ({ outcome: "duplicate" });
    expect(await settler(s)(deposit(), "0xabc")).toBeNull();
  });

  test("uses the nonce it is given as the payment reference", async () => {
    const { s, settled } = store([intent("a")]);
    await settler(s)(deposit({ depositIndex: 1 }), "0xabc:1");
    expect(settled[0]!.verified.proofNonce).toBe("0xabc:1");
  });
});
