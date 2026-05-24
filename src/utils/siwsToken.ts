import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config/env.js";

const TTL_SECONDS = 86_400; // 24 hours

interface TokenPayload {
  sub: string; // normalized wallet address
  iat: number; // issued-at unix seconds
  exp: number; // expiry unix seconds
}

/**
 * Issue a SIWS bearer token for a verified wallet address.
 * Format: siws_<base64url(payload)>.<hex(hmac-sha256)>
 */
export function issueToken(wallet: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ sub: wallet, iat, exp: iat + TTL_SECONDS }));
  const sig = hmac(payload);
  return `siws_${payload}.${sig}`;
}

/**
 * Verify a raw bearer token string.
 * Returns the wallet address on success, null on any failure (expired, tampered, wrong format).
 */
export function verifyToken(raw: string): string | null {
  if (!raw.startsWith("siws_")) return null;
  const inner = raw.slice(5);
  const dot = inner.lastIndexOf(".");
  if (dot === -1) return null;

  const payload = inner.slice(0, dot);
  const provided = inner.slice(dot + 1);
  const expected = hmac(payload);

  // Constant-time comparison — both are 64-char hex strings from HMAC-SHA256
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
  // Reject `iat` in the future. The HMAC binds the payload so only a
  // holder of SIWS_SECRET could forge this, but the check costs nothing
  // and removes the value of leaked-key forgeries dated in the future.
  // Tiny clock-skew tolerance (60s) — issuers and verifiers may drift.
  if (data.iat > now + 60) return null;

  return data.sub;
}

function b64u(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function hmac(payload: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");
}
