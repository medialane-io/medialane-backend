import { createHmac, timingSafeEqual } from "crypto";

const DOMAIN = "confirm-email-v1";
const PURPOSE = "confirm-email";

export interface ConfirmTokenClaims {
  accountId: string;
  email: string;
  expiresAt: Date;
}

const sign = (secret: string, payload: string): string =>
  createHmac("sha256", secret).update(`${DOMAIN}.${payload}`).digest("base64url");

export function issueConfirmToken(secret: string, claims: ConfirmTokenClaims): string {
  const payload = Buffer.from(
    JSON.stringify({ p: PURPOSE, a: claims.accountId, e: claims.email, x: Math.floor(claims.expiresAt.getTime() / 1000) }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyConfirmToken(secret: string, token: string, now: Date = new Date()): ConfirmTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, mac] = parts as [string, string];

  const given = Buffer.from(mac);
  const expected = Buffer.from(sign(secret, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (data.p !== PURPOSE || typeof data.a !== "string" || typeof data.e !== "string" || typeof data.x !== "number") {
      return null;
    }
    if (data.x * 1000 <= now.getTime()) return null;
    return { accountId: data.a, email: data.e, expiresAt: new Date(data.x * 1000) };
  } catch {
    return null;
  }
}
