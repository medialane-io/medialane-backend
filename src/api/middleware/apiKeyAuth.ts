import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { hashApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:apiKeyAuth");

/** Tenant keys from the portal are always `ml_live_<hex>` — never Clerk JWTs (`eyJ...`). */
function looksLikeTenantApiKey(s: string): boolean {
  return s.startsWith("ml_live_");
}

export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Prefer x-api-key so Authorization: Bearer <Clerk JWT> can coexist (user-bound routes).
  // Bearer is only treated as a tenant key when it looks like ml_live_... (README-compatible).
  const xKey = c.req.header("x-api-key")?.trim() ?? "";
  const authHeader = c.req.header("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const qKey = c.req.query("apiKey")?.trim() ?? "";

  const raw =
    xKey.length > 0
      ? xKey
      : looksLikeTenantApiKey(bearer)
        ? bearer
        : looksLikeTenantApiKey(qKey)
          ? qKey
          : null;

  if (!raw) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const keyHash = hashApiKey(raw);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      status: true,
      monthlyRequestCount: true,
      monthlyResetAt: true,
      tenant: {
        select: { id: true, name: true, email: true, plan: true, status: true },
      },
    },
  });

  if (!apiKey || apiKey.status !== "ACTIVE" || apiKey.tenant.status !== "ACTIVE") {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }

  // Fire-and-forget lastUsedAt update — never block the request
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => log.warn({ err }, "Failed to update lastUsedAt"));

  c.set("apiKey", apiKey);
  c.set("tenant", apiKey.tenant);

  await next();
};
