import prisma from "../db/client.js";
import { readAccountSession, sessionVerdict } from "./accountSessionToken.js";

export interface CurrentSession {
  accountId: string;
  /** When the session token was issued, in seconds since the epoch. */
  issuedAt: number;
}

/** The session's account and issue time, or null when the token is invalid or the account is not active or pending. */
export async function currentSession(raw: string): Promise<CurrentSession | null> {
  const session = readAccountSession(raw);
  if (!session) return null;
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { status: true },
  });
  if (!account) return null;
  return sessionVerdict(account) === "ok" ? session : null;
}
