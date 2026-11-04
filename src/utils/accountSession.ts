import prisma from "../db/client.js";
import { readAccountSession, sessionVerdict } from "./accountSessionToken.js";

export interface CurrentSession {
  accountId: string;
  /** When the session token was issued, in seconds since the epoch. */
  issuedAt: number;
}

export type SessionRead = ({ verdict: "ok" } & CurrentSession) | { verdict: "inactive" | "invalid" };

/**
 * Reads an account session: "invalid" when the token does not verify, its account does not exist, or the session
 * was issued before the account's sign-out cutoff; "inactive" when the account is inactive.
 */
export async function readSession(raw: string): Promise<SessionRead> {
  const session = readAccountSession(raw);
  if (!session) return { verdict: "invalid" };
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { status: true, sessionsValidFrom: true },
  });
  if (!account) return { verdict: "invalid" };
  const verdict = sessionVerdict(account, session.issuedAt);
  if (verdict === "ok") return { verdict, ...session };
  return { verdict: verdict === "inactive" ? "inactive" : "invalid" };
}

/** The session's account and issue time, or null when the session is not accepted. */
export async function currentSession(raw: string): Promise<CurrentSession | null> {
  const read = await readSession(raw);
  return read.verdict === "ok" ? { accountId: read.accountId, issuedAt: read.issuedAt } : null;
}
