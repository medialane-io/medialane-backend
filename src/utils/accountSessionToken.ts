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
