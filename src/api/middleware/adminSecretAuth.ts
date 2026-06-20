/**
 * Admin secret authentication - guards /admin/* routes.
 *
 * Requires `x-api-key: <env.API_SECRET_KEY>` and uses timing-safe
 * comparison to avoid leaking the secret via response timing.
 *
 * This is intentionally simpler than apiKeyAuth: one shared admin key
 * (operator-only), no DB lookup, no per-tenant scoping. The admin endpoints
 * themselves perform any further authorization required.
 */
import { timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";
import type { AppEnv } from "../../types/hono.js";

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") ?? "";
  const secretBuf = Buffer.from(env.API_SECRET_KEY);
  const keyBuf = Buffer.from(apiKey);
  // Lengths must match for timingSafeEqual — early reject on mismatch is acceptable
  // here because the secret length is not itself sensitive information.
  if (
    secretBuf.length !== keyBuf.length ||
    !timingSafeEqual(secretBuf, keyBuf)
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("isAdmin", true);
  await next();
};
