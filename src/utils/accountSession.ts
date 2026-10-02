import prisma from "../db/client.js";
import { accountSessionIssuedAt, isSessionCurrent, verifyAccountSessionToken } from "./accountSessionToken.js";

export async function currentAccountIdFromSession(raw: string): Promise<string | null> {
  const accountId = verifyAccountSessionToken(raw);
  if (!accountId) return null;
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { sessionsValidFrom: true } });
  if (!account) return null;
  return isSessionCurrent(accountSessionIssuedAt(raw), account.sessionsValidFrom) ? accountId : null;
}
