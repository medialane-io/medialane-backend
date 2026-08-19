import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config/env.js";

const TTL_SECONDS = 30 * 24 * 60 * 60;
const PREFIX = "account_session_";

interface TokenPayload {
  accountId: string;
  iat: number;
  exp: number;
}

export function issueAccountSessionToken(accountId: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ accountId, iat, exp: iat + TTL_SECONDS }));
  return `${PREFIX}${payload}.${hmac(payload)}`;
}

export function verifyAccountSessionToken(raw: string): string | null {
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

  if (!data.accountId || !data.exp || !data.iat) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.exp < now) return null;
  if (data.iat > now + 60) return null;

  return data.accountId;
}

function b64u(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function hmac(payload: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");
}
