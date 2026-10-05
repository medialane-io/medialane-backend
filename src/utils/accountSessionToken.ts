import {
  issueAccountSessionToken as issueShared,
  verifyAccountSessionToken as verifyShared,
} from "@medialane/sdk";
import { env } from "../config/env.js";

export function issueAccountSessionToken(accountId: string, ttlSeconds?: number): string {
  return issueShared(env.SIWS_SECRET, accountId, ttlSeconds);
}

export function verifyAccountSessionToken(raw: string): string | null {
  return verifyShared(env.SIWS_SECRET, raw);
}

export function isSessionCurrent(issuedAt: number | null, validFrom: Date | null): boolean {
  if (!validFrom) return true;
  if (issuedAt === null) return false;
  return issuedAt >= Math.floor(validFrom.getTime() / 1000);
}

const ACCOUNT_SESSION_PREFIX = "account_session_";


export function accountSessionIssuedAt(raw: string): number | null {
  if (verifyAccountSessionToken(raw) === null) return null;

  const body = raw.startsWith(ACCOUNT_SESSION_PREFIX) ? raw.slice(ACCOUNT_SESSION_PREFIX.length) : raw;
  const payload = body.split(".")[0];
  if (!payload) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat?: unknown };
    return typeof decoded.iat === "number" ? decoded.iat : null;
  } catch {
    return null;
  }
}

export type SessionVerdict = "ok" | "inactive" | "expired";

export function sessionVerdict(
  account: { status: string; sessionsValidFrom: Date | null },
  raw: string,
): SessionVerdict {
  if (account.status === "INACTIVE") return "inactive";
  return isSessionCurrent(accountSessionIssuedAt(raw), account.sessionsValidFrom) ? "ok" : "expired";
}
