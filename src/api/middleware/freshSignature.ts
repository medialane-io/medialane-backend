import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";

export const FRESH_SIGNATURE_SECONDS = 10 * 60;

export const freshSignature: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("walletAddress")) return next();

  const issuedAt = c.get("subjectTokenIssuedAt");
  if (issuedAt === undefined || !isFresh(issuedAt)) {
    return c.json(
      {
        error: "stale_signature",
        message: "Sign in again to do this. A stored sign-in is not enough on its own.",
      },
      401,
    );
  }

  return next();
};

export function isFresh(issuedAt: number, now: number = Math.floor(Date.now() / 1000)): boolean {
  if (issuedAt > now + 60) return false;
  return now - issuedAt <= FRESH_SIGNATURE_SECONDS;
}
