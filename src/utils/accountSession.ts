import prisma from "../db/client.js";
import { readAccountSession, sessionVerdict } from "./accountSessionToken.js";

export interface CurrentSession {
  accountId: string;
  issuedAt: number;
}

export type SessionRead = ({ verdict: "ok" } & CurrentSession) | { verdict: "inactive" | "invalid" };

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

export async function currentSession(raw: string): Promise<CurrentSession | null> {
  const read = await readSession(raw);
  return read.verdict === "ok" ? { accountId: read.accountId, issuedAt: read.issuedAt } : null;
}
