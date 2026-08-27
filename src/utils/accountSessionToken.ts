import {
  issueAccountSessionToken as issueShared,
  verifyAccountSessionToken as verifyShared,
} from "@medialane/sdk";
import { env } from "../config/env.js";

/**
 * Binds the platform secret to the shared token implementation in
 * @medialane/sdk. See ./siwsToken.ts — the signing logic is shared for the
 * same reason.
 */

export function issueAccountSessionToken(accountId: string): string {
  return issueShared(env.SIWS_SECRET, accountId);
}

export function verifyAccountSessionToken(raw: string): string | null {
  return verifyShared(env.SIWS_SECRET, raw);
}
