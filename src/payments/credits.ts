import prismaDefault from "../db/client.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { addPayment } from "./ledger.js";

export type CreditsDb = PrismaClient | Prisma.TransactionClient;

function inTransaction<T>(db: CreditsDb, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db);
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

export async function creditAccount(input: CreditInput, db: CreditsDb = prismaDefault): Promise<void> {
  await inTransaction(db, async (tx) => {
    const payment = await tx.payment.create({
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
      select: { id: true },
    });
    await addPayment(tx, input.apiCreditsId, input.creditedAmount, payment.id);
  });
}

export async function settleUnattributedPayment(input: CreditInput, db: CreditsDb = prismaDefault): Promise<boolean> {
  return inTransaction(db, async (tx) => {
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

    const payment = await tx.payment.findUniqueOrThrow({ where: { proofNonce: input.proofNonce }, select: { id: true } });
    await addPayment(tx, input.apiCreditsId, input.creditedAmount, payment.id);
    return true;
  });
}
