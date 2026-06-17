import { describe, expect, test } from "bun:test";
import { debitCredits, creditTenant, type CreditsDb } from "./credits.js";

function stubDb(over: Partial<{ count: number }> = {}): {
  db: CreditsDb;
  calls: { updateMany: number; paymentCreate: number; tenantUpdate: number; txOps: number };
} {
  const calls = { updateMany: 0, paymentCreate: 0, tenantUpdate: 0, txOps: 0 };
  const db: CreditsDb = {
    tenant: {
      async updateMany() {
        calls.updateMany++;
        return { count: over.count ?? 1 };
      },
      async update() {
        calls.tenantUpdate++;
        return {};
      },
    },
    payment: {
      async create() {
        calls.paymentCreate++;
        return {};
      },
    },
    async $transaction(ops: unknown[]) {
      calls.txOps = ops.length;
      return Promise.all(ops as Promise<unknown>[]);
    },
  };
  return { db, calls };
}

describe("debitCredits", () => {
  test("returns true when a row is decremented (sufficient balance)", async () => {
    const { db, calls } = stubDb({ count: 1 });
    expect(await debitCredits("t1", 5, db)).toBe(true);
    expect(calls.updateMany).toBe(1);
  });
  test("returns false when no row matched (insufficient balance)", async () => {
    const { db } = stubDb({ count: 0 });
    expect(await debitCredits("t1", 5, db)).toBe(false);
  });
});

describe("creditTenant", () => {
  test("writes a Payment row and increments the balance in one transaction", async () => {
    const { db, calls } = stubDb();
    await creditTenant(
      {
        tenantId: "t1",
        amountAtomic: 1_000_000n,
        creditedAmount: 1200,
        mdlnMultiplier: 1.2,
        scheme: "starknet-transfer",
        network: "starknet",
        asset: "0xusdc",
        txHash: "0xabc",
        proofNonce: "0xabc:1",
      },
      db,
    );
    expect(calls.paymentCreate).toBe(1);
    expect(calls.tenantUpdate).toBe(1);
    expect(calls.txOps).toBe(2);
  });
});
