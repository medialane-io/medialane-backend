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

/** Timing-safe equality. Length mismatch is an acceptable early reject (the
 *  secret's length is not itself sensitive). */
function secretMatches(presented: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") ?? "";
  if (!secretMatches(apiKey, env.API_SECRET_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("isAdmin", true);
  await next();
};

/**
 * Admin auth that ALSO accepts the account-scoped `PORTAL_SERVICE_SECRET` — but
 * only on `/admin/accounts/*`. Everywhere else this behaves exactly like
 * `authMiddleware` (master key only). Lets the developer portal hold a key that
 * can manage per-account keys/credits without holding the full admin master key.
 */
export const adminOrPortalAccountAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") ?? "";

  if (secretMatches(apiKey, env.API_SECRET_KEY)) {
    c.set("isAdmin", true);
    return next();
  }

  const isAccountRoute = c.req.path.startsWith("/admin/accounts");
  if (isAccountRoute && secretMatches(apiKey, env.PORTAL_SERVICE_SECRET)) {
    // Scoped service caller — NOT a full admin; only the account routes accept it.
    return next();
  }

  return c.json({ error: "Unauthorized" }, 401);
};
