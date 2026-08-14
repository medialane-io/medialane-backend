import prismaDefault from "../db/client.js";

export interface CreditsDb {
  apiClient: {
    updateMany(args: unknown): Promise<{ count: number }>;
    update(args: unknown): Promise<unknown>;
  };
  payment: { create(args: unknown): Promise<unknown> };
  $transaction(ops: unknown[]): Promise<unknown>;
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
