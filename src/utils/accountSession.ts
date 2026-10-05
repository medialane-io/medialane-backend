import prisma from "../db/client.js";
import { sessionVerdict, verifyAccountSessionToken } from "./accountSessionToken.js";

export async function currentAccountIdFromSession(raw: string): Promise<string | null> {
  const accountId = verifyAccountSessionToken(raw);
  if (!accountId) return null;
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { status: true, sessionsValidFrom: true },
  });
  if (!account) return null;
  return sessionVerdict(account, raw) === "ok" ? accountId : null;
}
