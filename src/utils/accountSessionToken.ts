import {
  issueAccountSessionToken as issueShared,
  readAccountSessionToken as readShared,
} from "@medialane/sdk";
import { env } from "../config/env.js";

export function issueAccountSessionToken(accountId: string): string {
  return issueShared(env.SIWS_SECRET, accountId);
}

export function readAccountSession(raw: string): { accountId: string; issuedAt: number } | null {
  return readShared(env.SIWS_SECRET, raw);
}

export type SessionVerdict = "ok" | "inactive" | "ended";

export function sessionVerdict(
  account: { status: string; sessionsValidFrom: Date | null },
  issuedAt: number,
): SessionVerdict {
  if (account.status === "INACTIVE") return "inactive";
  if (account.sessionsValidFrom && issuedAt < Math.floor(account.sessionsValidFrom.getTime() / 1000)) return "ended";
  return "ok";
}
