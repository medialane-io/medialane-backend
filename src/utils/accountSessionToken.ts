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

export type SessionVerdict = "ok" | "inactive";

export function sessionVerdict(account: { status: string }): SessionVerdict {
  return account.status === "INACTIVE" ? "inactive" : "ok";
}
