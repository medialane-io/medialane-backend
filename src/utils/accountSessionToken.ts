import {
  issueAccountSessionToken as issueShared,
  readAccountSessionToken as readShared,
  verifyAccountSessionToken as verifyShared,
} from "@medialane/sdk";
import { env } from "../config/env.js";

export function issueAccountSessionToken(accountId: string, ttlSeconds?: number): string {
  return issueShared(env.SIWS_SECRET, accountId, ttlSeconds);
}

export function verifyAccountSessionToken(raw: string): string | null {
  return verifyShared(env.SIWS_SECRET, raw);
}

/** The account a valid session token is for, and when it was issued (seconds since the epoch). */
export function readAccountSession(raw: string): { accountId: string; issuedAt: number } | null {
  return readShared(env.SIWS_SECRET, raw);
}

export type SessionVerdict = "ok" | "inactive";

export function sessionVerdict(account: { status: string }): SessionVerdict {
  return account.status === "INACTIVE" ? "inactive" : "ok";
}
