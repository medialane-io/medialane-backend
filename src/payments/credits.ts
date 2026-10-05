import prismaDefault from "../db/client.js";
import type { Prisma } from "@prisma/client";

export interface CreditsTx {
  apiCredits: { update(args: Prisma.ApiCreditsUpdateArgs): Promise<unknown> };
  payment: { updateMany(args: Prisma.PaymentUpdateManyArgs): Promise<{ count: number }> };
}

export interface CreditsDb {
  apiCredits: {
    updateMany(args: Prisma.ApiCreditsUpdateManyArgs): Promise<{ count: number }>;
    update(args: Prisma.ApiCreditsUpdateArgs): Promise<unknown>;
  };
  payment: { create(args: Prisma.PaymentCreateArgs): Promise<unknown> };
  $transaction(ops: unknown[]): Promise<unknown>;
}

export interface UnattributedDb {
  $transaction<T>(fn: (tx: CreditsTx) => Promise<T>): Promise<T>;
}

export async function debitCredits(
  apiCreditsId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<boolean> {
  const res = await db.apiCredits.updateMany({
    where: { id: apiCreditsId, creditBalance: { gte: cost } },
    data: { creditBalance: { decrement: cost } },
  });
  return res.count > 0;
}

export async function refundCredits(
  apiCreditsId: string,
  cost: number,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<void> {
  await db.apiCredits.update({
    where: { id: apiCreditsId },
    data: { creditBalance: { increment: cost } },
  });
}

export interface CreditInput {
  payer?: string;
  apiCreditsId: string;

  accountId: string;
  amountAtomic: bigint;
  creditedAmount: number;
  mdlnMultiplier: number;
  scheme: string;
  network: string;
  asset: string;
  txHash: string;
  proofNonce: string;
}

export async function creditAccount(
  input: CreditInput,
  db: CreditsDb = prismaDefault as unknown as CreditsDb,
): Promise<void> {
  await db.$transaction([
    db.payment.create({
      data: {
        apiCreditsId: input.apiCreditsId,
        payer: input.payer,
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
    db.apiCredits.update({
      where: { id: input.apiCreditsId },
      data: { creditBalance: { increment: input.creditedAmount } },
    }),
  ]);
}

export async function settleUnattributedPayment(
  input: CreditInput,
  db: UnattributedDb = prismaDefault as unknown as UnattributedDb,
): Promise<boolean> {
  return db.$transaction(async (tx: CreditsTx) => {
    const claimed = await tx.payment.updateMany({
      where: { proofNonce: input.proofNonce, status: "UNATTRIBUTED" },
      data: {
        apiCreditsId: input.apiCreditsId,
        payer: input.payer,
        scheme: input.scheme,
        network: input.network,
        asset: input.asset,
        amountAtomic: input.amountAtomic.toString(),
        creditedAmount: input.creditedAmount,
        mdlnMultiplier: input.mdlnMultiplier,
        status: "SETTLED",
        txHash: input.txHash,
      },
    });
    if (claimed.count === 0) return false;

    await tx.apiCredits.update({
      where: { id: input.apiCreditsId },
      data: { creditBalance: { increment: input.creditedAmount } },
    });
    return true;
  });
}
