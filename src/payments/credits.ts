import prismaDefault from "../db/client.js";

// Minimal surface of the Prisma client these functions touch — lets tests
// inject a stub instead of globally mocking the db module (which bun's
// process-global mock.module would leak across test files).
export interface CreditsDb {
  account: {
    updateMany(args: unknown): Promise<{ count: number }>;
    update(args: unknown): Promise<unknown>;
  };
  payment: { create(args: unknown): Promise<unknown> };
  $transaction(ops: unknown[]): Promise<unknown>;
}

/**
 * Atomic spend against the Account's credit balance (07-identity §III): decrement
 * only if the balance covers `cost`. Returns true if a row was updated (paid),
 * false if insufficient. Concurrency-safe — the WHERE clause makes the
 * check-and-decrement a single DB operation.
 */
export async function debitCredits(
  accountId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<boolean> {
  const res = await db.account.updateMany({
    where: { id: accountId, creditBalance: { gte: cost } },
    data: { creditBalance: { decrement: cost } },
  });
  return res.count > 0;
}

/**
 * Release a reservation taken by {@link debitCredits} when the request the
 * caller paid for failed on OUR side (5xx / uncaught error). This is NOT a
 * settlement — no money moved and no `Payment` ledger row is written; it just
 * increments the balance back by `cost`. 4xx (caller's bad input) is NOT
 * refunded. See `meter()` for the policy.
 */
export async function refundCredits(
  accountId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<void> {
  await db.account.update({
    where: { id: accountId },
    data: { creditBalance: { increment: cost } },
  });
}

export interface CreditInput {
  accountId: string;
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
 * Record the payment and grant credits to the Account atomically. The unique
 * `proofNonce` makes a replayed proof throw on the Payment insert, so credits are
 * never double-granted; callers treat a unique-violation as "already credited".
 */
export async function creditAccount(
  input: CreditInput,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<void> {
  await db.$transaction([
    db.payment.create({
      data: {
        accountId: input.accountId,
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
    db.account.update({
      where: { id: input.accountId },
      data: { creditBalance: { increment: input.creditedAmount } },
    }),
  ]);
}
