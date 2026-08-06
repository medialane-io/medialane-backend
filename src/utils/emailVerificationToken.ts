import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config/env.js";

const TTL_SECONDS = 10 * 60; // 10 minutes
const PREFIX = "email_verified_";

interface TokenPayload {
  email: string;
  iat: number;
  exp: number;
}

/**
 * Issue a short-lived, single-purpose token proving an email was just
 * verified via a one-time code. Same HMAC-SHA256(SIWS_SECRET) primitive
 * `siwsToken.ts` uses — no new secret to provision — but a distinct prefix
 * so the two token kinds can never be confused for one another, and a much
 * shorter TTL (this proves a moment-ago fact, not an ongoing session).
 */
export function issueEmailVerifiedToken(email: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ email, iat, exp: iat + TTL_SECONDS }));
  return `${PREFIX}${payload}.${hmac(payload)}`;
}

/** Verify a raw token string. Returns the verified email, or null on any failure. */
export function verifyEmailVerifiedToken(raw: string): string | null {
  if (!raw.startsWith(PREFIX)) return null;
  const inner = raw.slice(PREFIX.length);
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

  if (!data.email || !data.exp || !data.iat) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.exp < now) return null;
  if (data.iat > now + 60) return null; // reject future-dated issuance (60s clock-skew tolerance)

  return data.email;
}

function b64u(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function hmac(payload: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");
}
