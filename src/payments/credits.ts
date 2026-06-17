import prisma from "../db/client.js";

/**
 * Atomic spend: decrement only if the balance covers `cost`. Returns true if a
 * row was updated (paid), false if insufficient. Concurrency-safe — the WHERE
 * clause makes the check-and-decrement a single DB operation.
 */
export async function debitCredits(tenantId: string, cost: number): Promise<boolean> {
  const res = await prisma.tenant.updateMany({
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
export async function creditTenant(input: CreditInput): Promise<void> {
  await prisma.$transaction([
    prisma.payment.create({
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
    prisma.tenant.update({
      where: { id: input.tenantId },
      data: { creditBalance: { increment: input.creditedAmount } },
    }),
  ]);
}
