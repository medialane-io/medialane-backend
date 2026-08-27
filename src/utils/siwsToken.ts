import type { Chain } from "@prisma/client";
import {
  issueSiwsToken,
  verifySiwsToken,
  type SiwsIdentity,
} from "@medialane/sdk";
import { env } from "../config/env.js";

/**
 * Binds the platform secret to the shared token implementation in
 * @medialane/sdk. The signing and verification logic deliberately does not
 * live here: it previously existed as three separate copies — this one and one
 * inside each app that checks these tokens — all sharing a secret with nothing
 * keeping them in step. Changing the signature in one place silently
 * invalidated every token for the others.
 *
 * This module now owns exactly one thing: where the secret comes from.
 */

export type VerifiedIdentity = SiwsIdentity;

export function issueToken(chain: Chain, wallet: string): string {
  return issueSiwsToken(env.SIWS_SECRET, chain as VerifiedIdentity["chain"], wallet);
}

export function verifyToken(raw: string): VerifiedIdentity | null {
  return verifySiwsToken(env.SIWS_SECRET, raw);
}
