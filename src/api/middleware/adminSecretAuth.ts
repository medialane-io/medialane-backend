
import { timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";
import type { AppEnv } from "../../types/hono.js";

export function secretMatches(presented: string, secret: string | undefined): boolean {
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

export const adminOrPortalAccountAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") ?? "";

  if (secretMatches(apiKey, env.API_SECRET_KEY)) {
    c.set("isAdmin", true);
    return next();
  }

  const isPortalScopedRoute =
    c.req.path.startsWith("/admin/accounts") || c.req.path.startsWith("/admin/api-clients");
  if (isPortalScopedRoute && secretMatches(apiKey, env.PORTAL_SERVICE_SECRET)) {
    return next();
  }

  return c.json({ error: "Unauthorized" }, 401);
};
