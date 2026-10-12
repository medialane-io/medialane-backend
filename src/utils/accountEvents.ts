import type { AccountEventType, Prisma } from "@prisma/client";

export async function recordAccountEvent(
  db: Prisma.TransactionClient,
  accountId: string,
  type: AccountEventType,
  data: Prisma.InputJsonObject,
): Promise<void> {
  await db.accountEvent.create({ data: { accountId, type, data } });
}
