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
  const expected = hmac(payload);

  if (provided.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }

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

function hmac(payload: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");
}
