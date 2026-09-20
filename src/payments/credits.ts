import prismaDefault from "../db/client.js";
import type { Prisma } from "@prisma/client";

export interface CreditsTx {
  apiClient: { update(args: Prisma.ApiClientUpdateArgs): Promise<unknown> };
  payment: { updateMany(args: Prisma.PaymentUpdateManyArgs): Promise<{ count: number }> };
}

export interface CreditsDb {
  apiClient: {
    updateMany(args: Prisma.ApiClientUpdateManyArgs): Promise<{ count: number }>;
    update(args: Prisma.ApiClientUpdateArgs): Promise<unknown>;
  };
  payment: { create(args: Prisma.PaymentCreateArgs): Promise<unknown> };
  $transaction(ops: unknown[]): Promise<unknown>;
}

export interface UnattributedDb {
  $transaction<T>(fn: (tx: CreditsTx) => Promise<T>): Promise<T>;
}

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
  payer?: string;
  apiClientId: string;

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
        apiClientId: input.apiClientId,
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
    db.apiClient.update({
      where: { id: input.apiClientId },
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
        apiClientId: input.apiClientId,
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

    await tx.apiClient.update({
      where: { id: input.apiClientId },
      data: { creditBalance: { increment: input.creditedAmount } },
    });
    return true;
  });
}
