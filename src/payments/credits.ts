import prismaDefault from "../db/client.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeEntry, type EntryRef } from "./ledger.js";

export type CreditsDb = PrismaClient | Prisma.TransactionClient;

function inTransaction<T>(db: CreditsDb, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db);
}

export async function debitCredits(
  apiCreditsId: string,
  cost: number,
  db: CreditsDb = prismaDefault,
  ref: EntryRef = {},
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const res = await tx.apiCredits.updateMany({
      where: { id: apiCreditsId, creditBalance: { gte: cost } },
      data: { creditBalance: { decrement: cost } },
    });
    if (res.count === 0) return false;
    await writeEntry(tx, apiCreditsId, "USAGE", -cost, ref);
    return true;
  });
}

export async function refundCredits(
  apiCreditsId: string,
  cost: number,
  db: CreditsDb = prismaDefault,
  ref: EntryRef = {},
): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx.apiCredits.update({
      where: { id: apiCreditsId },
      data: { creditBalance: { increment: cost } },
    });
    await writeEntry(tx, apiCreditsId, "REFUND", cost, ref);
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
    await tx.apiCredits.update({
      where: { id: input.apiCreditsId },
      data: { creditBalance: { increment: input.creditedAmount } },
    });
    await writeEntry(tx, input.apiCreditsId, "PAYMENT", input.creditedAmount, { paymentId: payment.id });
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
    await tx.apiCredits.update({
      where: { id: input.apiCreditsId },
      data: { creditBalance: { increment: input.creditedAmount } },
    });
    await writeEntry(tx, input.apiCreditsId, "PAYMENT", input.creditedAmount, { paymentId: payment.id });
    return true;
  });
}
