import type { CreditEntryKind, Prisma } from "@prisma/client";

export interface EntryRef {
  paymentId?: string;
  usageEventId?: string;
  launchpadRunId?: string;
  note?: string;
}

export function writeEntry(
  tx: Prisma.TransactionClient,
  apiCreditsId: string,
  kind: CreditEntryKind,
  credits: number,
  ref: EntryRef = {},
) {
  return tx.creditEntry.create({ data: { apiCreditsId, kind, credits, ...ref }, select: { id: true } });
}
