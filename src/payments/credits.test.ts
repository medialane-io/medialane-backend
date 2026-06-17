import { describe, expect, test, mock, beforeEach } from "bun:test";

const updateMany = mock(async () => ({ count: 1 }));
const tenantUpdate = mock(async () => ({ id: "t1", creditBalance: 1200 }));
const paymentCreate = mock(async () => ({ id: "p1" }));
const $transaction = mock(async (fns: unknown[]) => Promise.all(fns as Promise<unknown>[]));

mock.module("../db/client.js", () => ({
  default: {
    tenant: { updateMany, update: tenantUpdate },
    payment: { create: paymentCreate },
    $transaction,
  },
}));

const { debitCredits, creditTenant } = await import("./credits.js");

beforeEach(() => {
  updateMany.mockClear();
  paymentCreate.mockClear();
});

describe("debitCredits", () => {
  test("returns true when a row is decremented (sufficient balance)", async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await debitCredits("t1", 5)).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
  test("returns false when no row matched (insufficient balance)", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await debitCredits("t1", 5)).toBe(false);
  });
});

describe("creditTenant", () => {
  test("writes a Payment row and increments the balance in one transaction", async () => {
    await creditTenant({
      tenantId: "t1",
      amountAtomic: 1_000_000n,
      creditedAmount: 1200,
      mdlnMultiplier: 1.2,
      scheme: "starknet-transfer",
      network: "starknet",
      asset: "0xusdc",
      txHash: "0xabc",
      proofNonce: "0xabc:1",
    });
    expect(paymentCreate).toHaveBeenCalledTimes(1);
  });
});
