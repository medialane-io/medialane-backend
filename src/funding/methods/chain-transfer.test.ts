import { describe, expect, test } from "bun:test";
import {
  atomicFromUsdc,
  createChainTransferMethod,
  depositSatisfies,
  fundingTypedData,
  MAX_AMOUNT_ATOMIC,
  MIN_AMOUNT_ATOMIC,
} from "./chain-transfer.js";
import { TRANSFER_SELECTOR, type DepositEvent } from "../deposits.js";
import { x402Config } from "../../config/x402.js";
import { normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import type { StarknetReceipt } from "../../payments/schemes/starknet.js";
import type { FundingIntentRecord } from "../types.js";

const TRANSFER = "0x" + TRANSFER_SELECTOR.toString(16);
const APPROVAL = "0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff";
const PAYER = "0x000c9";
const HASH = "0x0abc";

function intent(over: Partial<FundingIntentRecord> = {}): FundingIntentRecord {
  return {
    id: "fi1",
    apiClientId: "ac1",
    method: "chain-transfer",
    status: "PENDING",
    payer: PAYER,
    params: { chain: "STARKNET", amountAtomic: "1000000" },
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function receiptWith(events: object[], over: object = {}): StarknetReceipt {
  return { execution_status: "SUCCEEDED", finality_status: "ACCEPTED_ON_L2", events, ...over } as StarknetReceipt;
}

// Real receipts list events WITHOUT a transaction_hash.
const usdcTransfer = (selector = TRANSFER, low = "0xf4240") => ({
  from_address: x402Config.usdcContract,
  keys: [selector, PAYER, x402Config.treasury],
  data: [low, "0x0"],
});

const method = (over: Partial<Parameters<typeof createChainTransferMethod>[0]> = {}) =>
  createChainTransferMethod({
    fetchReceipt: async () => receiptWith([usdcTransfer()]),
    verifySignature: async () => ({ ok: true }),
    ...over,
  });

describe("amounts", () => {
  test("decimal USDC becomes atomic units", () => {
    expect(atomicFromUsdc("10")).toBe(10_000_000n);
    expect(atomicFromUsdc("10.5")).toBe(10_500_000n);
    expect(atomicFromUsdc("0.000001")).toBe(1n);
  });

  test("parseParams enforces the limits", () => {
    const m = method();
    expect(m.parseParams({ amountUsdc: "1" })).toEqual({ ok: true, params: { chain: "STARKNET", amountAtomic: MIN_AMOUNT_ATOMIC.toString() } });
    expect(m.parseParams({ amountUsdc: "0.99" }).ok).toBe(false);
    expect(m.parseParams({ amountUsdc: "10000.01" }).ok).toBe(false);
    expect(m.parseParams({ amountUsdc: "10000" })).toMatchObject({ ok: true, params: { amountAtomic: MAX_AMOUNT_ATOMIC.toString() } });
    expect(m.parseParams({ amountUsdc: "abc" }).ok).toBe(false);
    expect(m.parseParams({ amountUsdc: "5", chain: "BASE" }).ok).toBe(false);
  });
});

describe("the challenge", () => {
  test("binds the intent, the wallet and the amount, in its own domain", () => {
    const td = fundingTypedData({ intentId: "fi1", payer: PAYER, amountAtomic: 1_000_000n }) as any;
    expect(td.primaryType).toBe("FundingIntent");
    expect(td.message).toEqual({ intent: "fi1", wallet: PAYER, amount: "1000000", app: "medialane.io/funding" });
  });

  test("a signature for one intent or amount does not match another challenge", () => {
    const a = JSON.stringify(fundingTypedData({ intentId: "fi1", payer: PAYER, amountAtomic: 1_000_000n }));
    expect(JSON.stringify(fundingTypedData({ intentId: "fi2", payer: PAYER, amountAtomic: 1_000_000n }))).not.toBe(a);
    expect(JSON.stringify(fundingTypedData({ intentId: "fi1", payer: PAYER, amountAtomic: 2_000_000n }))).not.toBe(a);
  });

  test("challenge needs a payer address", () => {
    expect(method().challenge(intent({ payer: null }), {}).ok).toBe(false);
    expect(method().challenge(intent({ payer: null }), { payer: PAYER }).ok).toBe(true);
  });
});

describe("authorizing", () => {
  test("a valid signature returns where and how much to pay", async () => {
    const res = await method().authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1", "0x2"] });
    expect(res).toMatchObject({ ok: true, instructions: { amountAtomic: "1000000" } });
    if (res.ok) expect(BigInt(res.payer)).toBe(BigInt(PAYER));
  });

  test("an invalid signature is refused", async () => {
    const m = method({ verifySignature: async () => ({ ok: false, reason: "invalid" }) });
    const res = await m.authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1"] });
    expect(res.ok).toBe(false);
  });

  test("an undeployed wallet gets a clear message", async () => {
    const m = method({ verifySignature: async () => ({ ok: false, reason: "not_deployed" }) });
    const res = await m.authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1"] });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("deployed");
  });

  test("an intent that already has a payer cannot be authorized again", async () => {
    const res = await method().authorize(intent({ payer: "0xother" }), { payer: PAYER, signature: ["0x1"] });
    expect(res.ok).toBe(false);
  });

  test("the signature is checked against the intent's own challenge", async () => {
    let seen: unknown;
    const m = method({ verifySignature: async (args) => { seen = args.typedData; return { ok: true }; } });
    await m.authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1"] });
    const normalizedPayer = normalizeAddress("STARKNET", PAYER);
    expect(JSON.stringify(seen)).toBe(JSON.stringify(fundingTypedData({ intentId: "fi1", payer: normalizedPayer, amountAtomic: 1_000_000n })));
  });
});

describe("matching a deposit to an intent", () => {
  const deposit = (over: Partial<DepositEvent> = {}): DepositEvent => ({
    txHash: HASH,
    token: "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    amountAtomic: 1_000_000n,
    payer: PAYER,
    blockNumber: 1,
    depositIndex: 0,
    ...over,
  });

  test("the same payer, USDC and enough money satisfies it", () => {
    expect(depositSatisfies(deposit(), intent())).toBe(true);
    expect(depositSatisfies(deposit({ amountAtomic: 5_000_000n }), intent())).toBe(true);
  });

  test("too little money, another payer, another token, or no payer does not", () => {
    expect(depositSatisfies(deposit({ amountAtomic: 999_999n }), intent())).toBe(false);
    expect(depositSatisfies(deposit({ payer: "0xdead" }), intent())).toBe(false);
    expect(depositSatisfies(deposit({ token: "0xdead" }), intent())).toBe(false);
    expect(depositSatisfies(deposit(), intent({ payer: null }))).toBe(false);
  });
});

describe("verifying a submitted transaction", () => {
  test("a matching transfer is a verified payment, even though receipt events carry no transaction hash", async () => {
    const res = await method().verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: true, payment: { valueUsdcAtomic: 1_000_000n, scheme: "starknet-transfer", network: "starknet" } });
    if (res.ok) expect(BigInt(res.payment.proofNonce)).toBe(BigInt(HASH));
  });

  test("an Approval to the treasury is not a payment", async () => {
    const m = method({ fetchReceipt: async () => receiptWith([usdcTransfer(APPROVAL)]) });
    expect((await m.verify(intent(), { txHash: HASH })).ok).toBe(false);
  });

  test("a transfer from someone else is not the intent's payment", async () => {
    const other = { ...usdcTransfer(), keys: [TRANSFER, "0xdead", x402Config.treasury] };
    const m = method({ fetchReceipt: async () => receiptWith([other]) });
    expect((await m.verify(intent(), { txHash: HASH })).ok).toBe(false);
  });

  test("a reverted or unfinalized transaction is not a payment", async () => {
    const reverted = method({ fetchReceipt: async () => receiptWith([usdcTransfer()], { execution_status: "REVERTED" }) });
    expect((await reverted.verify(intent(), { txHash: HASH })).ok).toBe(false);
    const pending = method({ fetchReceipt: async () => receiptWith([usdcTransfer()], { finality_status: "RECEIVED" }) });
    expect((await pending.verify(intent(), { txHash: HASH })).ok).toBe(false);
  });

  test("a transaction not in a block yet asks the caller to retry", async () => {
    const m = method({ fetchReceipt: async () => { throw new Error("not found"); } });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.reason).toContain("try again");
  });

  test("a bad hash or an intent with no payer is rejected", async () => {
    expect((await method().verify(intent(), { txHash: "nope" })).ok).toBe(false);
    expect((await method().verify(intent({ payer: null }), { txHash: HASH })).ok).toBe(false);
  });

  test("the first matching deposit's reference equals the transaction hash, the same value the scanner computes", async () => {
    const m = method({ fetchReceipt: async () => receiptWith([usdcTransfer(), usdcTransfer()]) });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payment.proofNonce).toBe(normalizeHash(HASH));
  });
});
