import {
  issueAccountSessionToken as issueShared,
  verifyAccountSessionToken as verifyShared,
} from "@medialane/sdk";
import { env } from "../config/env.js";

export function issueAccountSessionToken(accountId: string): string {
  return issueShared(env.SIWS_SECRET, accountId);
}

export function verifyAccountSessionToken(raw: string): string | null {
  return verifyShared(env.SIWS_SECRET, raw);
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
