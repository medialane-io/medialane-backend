import type { Chain } from "@prisma/client";
import {
  issueSiwsToken,
  verifySiwsToken,
  type SiwsIdentity,
} from "@medialane/sdk";
import { env } from "../config/env.js";

export type VerifiedIdentity = SiwsIdentity;

export function issueToken(chain: Chain, wallet: string): string {
  return issueSiwsToken(env.SIWS_SECRET, chain as VerifiedIdentity["chain"], wallet);
}

export function verifyToken(raw: string): VerifiedIdentity | null {
  return verifySiwsToken(env.SIWS_SECRET, raw);
}
