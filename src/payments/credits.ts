import prismaDefault from "../db/client.js";

// Minimal surface of the Prisma client these functions touch — lets tests
// inject a stub instead of globally mocking the db module (which bun's
// process-global mock.module would leak across test files).
export interface CreditsDb {
  tenant: {
    updateMany(args: unknown): Promise<{ count: number }>;
    update(args: unknown): Promise<unknown>;
  };
  payment: { create(args: unknown): Promise<unknown> };
  $transaction(ops: unknown[]): Promise<unknown>;
}

/**
 * Atomic spend: decrement only if the balance covers `cost`. Returns true if a
 * row was updated (paid), false if insufficient. Concurrency-safe — the WHERE
 * clause makes the check-and-decrement a single DB operation.
 */
export async function debitCredits(
  tenantId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<boolean> {
  const res = await db.tenant.updateMany({
    where: { id: tenantId, creditBalance: { gte: cost } },
    data: { creditBalance: { decrement: cost } },
  });
  return res.count > 0;
}

export interface CreditInput {
  tenantId: string;
  amountAtomic: bigint; // USDC atomic units paid
  creditedAmount: number; // credits granted (post-multiplier)
  mdlnMultiplier: number;
  scheme: string;
  network: string;
  asset: string;
  txHash: string;
  proofNonce: string; // unique — dedups replays
}

/**
 * Record the payment and grant credits atomically. The unique `proofNonce`
 * makes a replayed proof throw on the Payment insert, so credits are never
 * double-granted; callers treat a unique-violation as "already credited".
 */
export async function creditTenant(
  input: CreditInput,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<void> {
  await db.$transaction([
    db.payment.create({
      data: {
        tenantId: input.tenantId,
        scheme: input.scheme,
        network: input.network,
        asset: input.asset,
        amountAtomic: input.amountAtomic.toString(),
        creditedAmount: input.creditedAmount,
        mdlnMultiplier: input.mdlnMultiplier,
        status: "SETTLED",
        txHash: input.txHash,
        proofNonce: input.proofNonce,
      },
    }),
    db.tenant.update({
      where: { id: input.tenantId },
      data: { creditBalance: { increment: input.creditedAmount } },
    }),
  ]);
}
