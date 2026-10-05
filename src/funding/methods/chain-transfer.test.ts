import { describe, expect, test } from "bun:test";
import { atomicFromUsdc, createChainTransferMethod, depositValueFor, fundingTypedData } from "./chain-transfer.js";
import { tokenBySymbol } from "./assets.js";
import { TRANSFER_SELECTOR, type DepositEvent } from "../deposits.js";
import { x402Config } from "../../config/x402.js";
import { normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import type { StarknetReceipt } from "../../payments/schemes/starknet.js";
import type { FundingIntentRecord } from "../types.js";

const TRANSFER = "0x" + TRANSFER_SELECTOR.toString(16);
const APPROVAL = "0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff";
const PAYER = "0x000c9";
const HASH = "0x0abc";
const USDC = tokenBySymbol("USDC")!.address;
const ETH = tokenBySymbol("ETH")!.address;
const prices = async () => ({ USDC: 1, USDT: 1, ETH: 2000, STRK: 0.05 });
const noPrices = async () => null;

function intent(over: Partial<FundingIntentRecord> = {}, params: Record<string, unknown> = {}): FundingIntentRecord {
  return {
    id: "fi1",
    apiCreditsId: "ac1",
    method: "chain-transfer",
    status: "PENDING",
    payer: PAYER,
    params: { chain: "STARKNET", asset: "USDC", ...params },
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function receiptWith(events: object[], over: object = {}): StarknetReceipt {
  return { execution_status: "SUCCEEDED", finality_status: "ACCEPTED_ON_L2", events, ...over } as StarknetReceipt;
}

// Real receipts list events WITHOUT a transaction_hash.
const transfer = (token: string, low: string, selector = TRANSFER) => ({
  from_address: token,
  keys: [selector, PAYER, x402Config.treasury],
  data: [low, "0x0"],
});
const hex = (n: bigint) => "0x" + n.toString(16);

const method = (over: Partial<Parameters<typeof createChainTransferMethod>[0]> = {}) =>
  createChainTransferMethod({
    fetchReceipt: async () => receiptWith([transfer(USDC, hex(1_000_000n))]),
    verifySignature: async () => ({ ok: true }),
    readUsdPrices: prices,
    ...over,
  });

describe("starting a top-up", () => {
  test("decimal dollars become atomic units", () => {
    expect(atomicFromUsdc("10")).toBe(10_000_000n);
    expect(atomicFromUsdc("10.5")).toBe(10_500_000n);
    expect(atomicFromUsdc("0.01")).toBe(10_000n);
  });

  test("no amount is needed: it is only a suggestion", () => {
    expect(method().parseParams({})).toEqual({ ok: true, params: { chain: "STARKNET", asset: "USDC" } });
    expect(method().parseParams({ amountUsdc: "5" })).toEqual({
      ok: true,
      params: { chain: "STARKNET", asset: "USDC", suggestedUsdAtomic: "5000000" },
    });
  });

  test("there is no minimum beyond one cent and no maximum", () => {
    expect(method().parseParams({ amountUsdc: "0.01" }).ok).toBe(true);
    expect(method().parseParams({ amountUsdc: "250000" }).ok).toBe(true);
    expect(method().parseParams({ amountUsdc: "0" }).ok).toBe(false);
    expect(method().parseParams({ amountUsdc: "abc" }).ok).toBe(false);
  });

  test("any token the platform supports can be chosen, in any letter case, and no other", () => {
    expect(method().parseParams({ asset: "eth" })).toMatchObject({ ok: true, params: { asset: "ETH" } });
    expect(method().parseParams({ asset: "STRK" })).toMatchObject({ ok: true, params: { asset: "STRK" } });
    expect(method().parseParams({ asset: "DOGE" }).ok).toBe(false);
  });

  test("only Starknet for now", () => {
    expect(method().parseParams({ chain: "BASE" }).ok).toBe(false);
  });
});

describe("the challenge", () => {
  test("proves ownership of the wallet for this top-up, in its own domain", () => {
    const td = fundingTypedData({ intentId: "fi1", payer: PAYER }) as any;
    expect(td.primaryType).toBe("FundingIntent");
    expect(td.message).toEqual({ intent: "fi1", wallet: PAYER, app: "medialane.io/funding" });
  });

  test("a signature for one top-up or wallet does not match another challenge", () => {
    const a = JSON.stringify(fundingTypedData({ intentId: "fi1", payer: PAYER }));
    expect(JSON.stringify(fundingTypedData({ intentId: "fi2", payer: PAYER }))).not.toBe(a);
    expect(JSON.stringify(fundingTypedData({ intentId: "fi1", payer: "0xdead" }))).not.toBe(a);
  });

  test("challenge needs a payer address", () => {
    expect(method().challenge(intent({ payer: null }), {}).ok).toBe(false);
    expect(method().challenge(intent({ payer: null }), { payer: PAYER }).ok).toBe(true);
  });
});

describe("authorizing", () => {
  test("a valid signature returns where to pay and which tokens count", async () => {
    const res = await method().authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1", "0x2"] });
    expect(res).toMatchObject({ ok: true, instructions: { assetSymbol: "USDC" } });
    if (res.ok) {
      expect(BigInt(res.payer)).toBe(BigInt(PAYER));
      expect(res.instructions.assets).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: "ETH", decimals: 18 })]));
    }
  });

  test("with a suggested amount it also says how much of the chosen token that is", async () => {
    const usdc = await method().authorize(intent({ payer: null }, { suggestedUsdAtomic: "5000000" }), { payer: PAYER, signature: ["0x1"] });
    expect(usdc).toMatchObject({ ok: true, instructions: { amountAtomic: "5000000" } });
    const eth = await method().authorize(intent({ payer: null }, { asset: "ETH", suggestedUsdAtomic: "5000000" }), { payer: PAYER, signature: ["0x1"] });
    expect(eth).toMatchObject({ ok: true, instructions: { assetSymbol: "ETH", amountAtomic: "2500000000000000" } });
    if (eth.ok) expect(BigInt(eth.instructions.asset as string)).toBe(BigInt(ETH));
  });

  test("without a suggested amount there is nothing to convert, so no price is needed", async () => {
    const res = await method({ readUsdPrices: noPrices }).authorize(intent({ payer: null }, { asset: "ETH" }), { payer: PAYER, signature: ["0x1"] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.instructions.amountAtomic).toBeUndefined();
  });

  test("a suggested ETH amount cannot be converted without a price", async () => {
    const res = await method({ readUsdPrices: noPrices }).authorize(intent({ payer: null }, { asset: "ETH", suggestedUsdAtomic: "5000000" }), { payer: PAYER, signature: ["0x1"] });
    expect(res.ok).toBe(false);
  });

  test("an invalid signature is refused", async () => {
    const m = method({ verifySignature: async () => ({ ok: false, reason: "invalid" }) });
    expect((await m.authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1"] })).ok).toBe(false);
  });

  test("an undeployed wallet gets a clear message", async () => {
    const m = method({ verifySignature: async () => ({ ok: false, reason: "not_deployed" }) });
    const res = await m.authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1"] });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("deployed");
  });

  test("a top-up that already has a payer cannot be authorized again", async () => {
    expect((await method().authorize(intent({ payer: "0xother" }), { payer: PAYER, signature: ["0x1"] })).ok).toBe(false);
  });

  test("the signature is checked against this top-up's own challenge", async () => {
    let seen: unknown;
    const m = method({ verifySignature: async (args) => { seen = args.typedData; return { ok: true }; } });
    await m.authorize(intent({ payer: null }), { payer: PAYER, signature: ["0x1"] });
    expect(JSON.stringify(seen)).toBe(JSON.stringify(fundingTypedData({ intentId: "fi1", payer: normalizeAddress("STARKNET", PAYER) })));
  });
});

describe("what a deposit is worth to a top-up", () => {
  const deposit = (over: Partial<DepositEvent> = {}): DepositEvent => ({
    txHash: HASH, token: USDC, amountAtomic: 5_000_000n, payer: PAYER, blockNumber: 1, depositIndex: 0, ...over,
  });

  test("USDC from the payer is worth what was sent, whatever the amount", async () => {
    expect(await depositValueFor(deposit(), intent(), noPrices)).toEqual({ ok: true, valueUsdcAtomic: 5_000_000n });
    expect(await depositValueFor(deposit({ amountAtomic: 10_000n }), intent(), noPrices)).toEqual({ ok: true, valueUsdcAtomic: 10_000n });
  });

  test("any supported token counts, valued at its dollar price", async () => {
    expect(await depositValueFor(deposit({ token: ETH, amountAtomic: 2_500_000_000_000_000n }), intent(), prices)).toEqual({ ok: true, valueUsdcAtomic: 5_000_000n });
  });

  test("a transfer worth less than one credit is dust: there is nothing to credit", async () => {
    expect(await depositValueFor(deposit({ amountAtomic: 9_999n }), intent(), noPrices)).toEqual({ ok: false, reason: "dust" });
  });

  test("another payer, an unsupported token, or a top-up with no payer does not match", async () => {
    expect(await depositValueFor(deposit({ payer: "0xdead" }), intent(), noPrices)).toEqual({ ok: false, reason: "mismatch" });
    expect(await depositValueFor(deposit({ token: "0xdead" }), intent(), noPrices)).toEqual({ ok: false, reason: "mismatch" });
    expect(await depositValueFor(deposit(), intent({ payer: null }), noPrices)).toEqual({ ok: false, reason: "mismatch" });
  });

  test("an ETH deposit that cannot be priced is reported as unpriced, never as zero", async () => {
    expect(await depositValueFor(deposit({ token: ETH, amountAtomic: 2_500_000_000_000_000n }), intent(), noPrices)).toEqual({ ok: false, reason: "unpriced" });
  });
});

describe("verifying a submitted transaction", () => {
  test("a transfer from the payer is a verified payment, even though receipt events carry no transaction hash", async () => {
    const res = await method().verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: true, payment: { valueUsdcAtomic: 1_000_000n, scheme: "starknet-transfer", network: "starknet" } });
    if (res.ok) expect(BigInt(res.payment.proofNonce)).toBe(BigInt(HASH));
  });

  test("an ETH transfer is credited at its dollar value", async () => {
    const m = method({ fetchReceipt: async () => receiptWith([transfer(ETH, hex(2_500_000_000_000_000n))]) });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: true, payment: { valueUsdcAtomic: 5_000_000n } });
    if (res.ok) expect(BigInt(res.payment.asset)).toBe(BigInt(ETH));
  });

  test("an ETH transfer that cannot be priced asks the caller to retry, and never credits", async () => {
    const m = method({ readUsdPrices: noPrices, fetchReceipt: async () => receiptWith([transfer(ETH, hex(2_500_000_000_000_000n))]) });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.reason).toContain("try again");
  });

  test("a transfer worth less than one credit says so", async () => {
    const m = method({ fetchReceipt: async () => receiptWith([transfer(USDC, hex(9_999n))]) });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.reason).toContain("one credit");
  });

  test("an Approval to the treasury is not a payment", async () => {
    const m = method({ fetchReceipt: async () => receiptWith([transfer(USDC, hex(1_000_000n), APPROVAL)]) });
    expect((await m.verify(intent(), { txHash: HASH })).ok).toBe(false);
  });

  test("a transfer from someone else is not this top-up's payment", async () => {
    const other = { ...transfer(USDC, hex(1_000_000n)), keys: [TRANSFER, "0xdead", x402Config.treasury] };
    const m = method({ fetchReceipt: async () => receiptWith([other]) });
    expect((await m.verify(intent(), { txHash: HASH })).ok).toBe(false);
  });

  test("a reverted or unfinalized transaction is not a payment", async () => {
    const good = [transfer(USDC, hex(1_000_000n))];
    const reverted = method({ fetchReceipt: async () => receiptWith(good, { execution_status: "REVERTED" }) });
    expect((await reverted.verify(intent(), { txHash: HASH })).ok).toBe(false);
    const pending = method({ fetchReceipt: async () => receiptWith(good, { finality_status: "RECEIVED" }) });
    expect((await pending.verify(intent(), { txHash: HASH })).ok).toBe(false);
  });

  test("a transaction not in a block yet asks the caller to retry", async () => {
    const m = method({ fetchReceipt: async () => { throw new Error("not found"); } });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.reason).toContain("try again");
  });

  test("a bad hash or a top-up with no payer is rejected", async () => {
    expect((await method().verify(intent(), { txHash: "nope" })).ok).toBe(false);
    expect((await method().verify(intent({ payer: null }), { txHash: HASH })).ok).toBe(false);
  });

  test("the first matching deposit's reference equals the transaction hash, the same value the scanner computes", async () => {
    const t = transfer(USDC, hex(1_000_000n));
    const m = method({ fetchReceipt: async () => receiptWith([t, t]) });
    const res = await m.verify(intent(), { txHash: HASH });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payment.proofNonce).toBe(normalizeHash(HASH));
  });
});
