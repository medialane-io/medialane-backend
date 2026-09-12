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

const IDENTITY_PREFIX = "siws_";

export function tokenIssuedAt(raw: string): number | null {
  if (verifyToken(raw) === null) return null;

  const body = raw.startsWith(IDENTITY_PREFIX) ? raw.slice(IDENTITY_PREFIX.length) : raw;
  const payload = body.split(".")[0];
  if (!payload) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat?: unknown };
    return typeof decoded.iat === "number" ? decoded.iat : null;
  } catch {
    return null;
  }
}
