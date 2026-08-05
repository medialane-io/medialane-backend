import prismaDefault from "../db/client.js";

// Minimal surface of the Prisma client these functions touch — lets tests
// inject a stub instead of globally mocking the db module (which bun's
// process-global mock.module would leak across test files).
export interface CreditsDb {
  apiClient: {
    updateMany(args: unknown): Promise<{ count: number }>;
    update(args: unknown): Promise<unknown>;
  };
  payment: { create(args: unknown): Promise<unknown> };
  $transaction(ops: unknown[]): Promise<unknown>;
}

/**
 * Atomic spend against the ApiClient's credit balance (see
 * docs/superpowers/specs/2026-08-05-api-client-model-design.md): decrement
 * only if the balance covers `cost`. Returns true if a row was updated (paid),
 * false if insufficient. Concurrency-safe — the WHERE clause makes the
 * check-and-decrement a single DB operation.
 */
export async function debitCredits(
  apiClientId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<boolean> {
  const res = await db.apiClient.updateMany({
    where: { id: apiClientId, creditBalance: { gte: cost } },
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
  apiClientId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<void> {
  await db.apiClient.update({
    where: { id: apiClientId },
    data: { creditBalance: { increment: cost } },
  });
}

export interface CreditInput {
  apiClientId: string;
  // Payment.accountId is still NOT NULL until the drop-old-columns migration
  // phase — dual-write both while that column exists. See
  // docs/superpowers/specs/2026-08-05-api-client-model-design.md.
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
 * Record the payment and grant credits to the ApiClient atomically. The unique
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
        apiClientId: input.apiClientId,
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
    db.apiClient.update({
      where: { id: input.apiClientId },
      data: { creditBalance: { increment: input.creditedAmount } },
    }),
  ]);
}
