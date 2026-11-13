import {
  issueAccountSessionToken as issueShared,
  readAccountSessionToken as readShared,
} from "@medialane/sdk";
import { env } from "../config/env.js";

export function issueAccountSessionToken(accountId: string): string {
  return issueShared(env.SIWS_SECRET, accountId);
}

/** The account a valid session token is for, and when it was issued (seconds since the epoch). */
export function readAccountSession(raw: string): { accountId: string; issuedAt: number } | null {
  return readShared(env.SIWS_SECRET, raw);
}

export type SessionVerdict = "ok" | "inactive" | "ended";

/**
 * Whether a session issued at `issuedAt` (seconds since the epoch) is accepted for this account. An inactive account
 * is refused first; otherwise a session issued before the account's `sessionsValidFrom` has ended.
 */
export function sessionVerdict(
  account: { status: string; sessionsValidFrom: Date | null },
  issuedAt: number,
): SessionVerdict {
  if (account.status === "INACTIVE") return "inactive";
  if (account.sessionsValidFrom && issuedAt < Math.floor(account.sessionsValidFrom.getTime() / 1000)) return "ended";
  return "ok";
}
