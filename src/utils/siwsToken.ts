import { createHmac, timingSafeEqual } from "crypto";
import type { Chain } from "@prisma/client";
import { env } from "../config/env.js";

const TTL_SECONDS = 86_400;

interface TokenPayload {
  sub: string;
  chain?: Chain;
  iat: number;
  exp: number;
}

export interface VerifiedIdentity {
  address: string;
  chain: Chain;
}

export function issueToken(chain: Chain, wallet: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ sub: wallet, chain, iat, exp: iat + TTL_SECONDS }));
  const sig = hmac(payload);
  return `siws_${payload}.${sig}`;
}

export function verifyToken(raw: string): VerifiedIdentity | null {
  if (!raw.startsWith("siws_")) return null;
  const inner = raw.slice(5);
  const dot = inner.lastIndexOf(".");
  if (dot === -1) return null;

  const payload = inner.slice(0, dot);
  const provided = inner.slice(dot + 1);
  if (!signatureMatches(payload, provided)) return null;

  let data: TokenPayload;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!data.sub || !data.exp || !data.iat) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.exp < now) return null;

  if (data.iat > now + 60) return null;

  return { address: data.sub, chain: data.chain ?? "STARKNET" };
}

function b64u(s: string): string {
  return Buffer.from(s).toString("base64url");
}

// Both token families are HMACed with the same secret. Without a domain tag
// the signature covers only the payload, so the *kind* of token is unauthenticated
// and the families are told apart purely by which fields they happen to carry.
// That holds today and would stop holding the moment either payload gained a
// field the other verifier reads. The tag makes the kind part of what is signed.
const DOMAIN = "siws-identity-v1";

function hmac(payload: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(DOMAIN).update(".").update(payload).digest("hex");
}

// Signatures issued before the domain tag existed. Accepted on verify so a
// deploy does not sign every existing session out; never issued. Remove once
// the longest TTL above has elapsed since rollout.
function legacyHmac(payload: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");
}

function signatureMatches(payload: string, provided: string): boolean {
  for (const expected of [hmac(payload), legacyHmac(payload)]) {
    if (provided.length !== expected.length) continue;
    try {
      if (timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))) return true;
    } catch {
      continue;
    }
  }
  return false;
}
