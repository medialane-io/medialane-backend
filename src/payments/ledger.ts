import prismaDefault from "../db/client.js";
import type { CreditEntryKind, Prisma, PrismaClient } from "@prisma/client";

export type LedgerDb = PrismaClient | Prisma.TransactionClient;

export interface EntryRef {
  paymentId?: string;
  launchpadRunId?: string;
  note?: string;
}

function inTransaction<T>(db: LedgerDb, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db);
}

function writeEntry(tx: Prisma.TransactionClient, apiCreditsId: string, kind: CreditEntryKind, credits: number, ref: EntryRef) {
  return tx.creditEntry.create({ data: { apiCreditsId, kind, credits, ...ref }, select: { id: true } });
}

export async function spend(
  apiCreditsId: string,
  credits: number,
  db: LedgerDb = prismaDefault,
  ref: EntryRef = {},
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const res = await tx.apiCredits.updateMany({
      where: { id: apiCreditsId, creditBalance: { gte: credits } },
      data: { creditBalance: { decrement: credits } },
    });
    if (res.count === 0) return false;
    await writeEntry(tx, apiCreditsId, "USAGE", -credits, ref);
    return true;
  });
}

async function add(
  db: LedgerDb,
  apiCreditsId: string,
  kind: "PAYMENT" | "GRANT" | "REFUND",
  credits: number,
  ref: EntryRef,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx.apiCredits.update({ where: { id: apiCreditsId }, data: { creditBalance: { increment: credits } } });
    await writeEntry(tx, apiCreditsId, kind, credits, ref);
  });
}

export function refund(apiCreditsId: string, credits: number, db: LedgerDb = prismaDefault, ref: EntryRef = {}) {
  return add(db, apiCreditsId, "REFUND", credits, ref);
}

export function addPayment(db: LedgerDb, apiCreditsId: string, credits: number, paymentId: string) {
  return add(db, apiCreditsId, "PAYMENT", credits, { paymentId });
}

export function grant(apiCreditsId: string, credits: number, note: string, db: LedgerDb = prismaDefault) {
  return add(db, apiCreditsId, "GRANT", credits, { note });
}

export async function charge(apiCreditsId: string, credits: number, db: LedgerDb = prismaDefault): Promise<boolean> {
  const res = await db.apiCredits.updateMany({
    where: { id: apiCreditsId, creditBalance: { gte: credits } },
    data: { creditBalance: { decrement: credits } },
  });
  return res.count > 0;
}

export async function returnCharge(apiCreditsId: string, credits: number, db: LedgerDb = prismaDefault): Promise<void> {
  await db.apiCredits.update({ where: { id: apiCreditsId }, data: { creditBalance: { increment: credits } } });
}
