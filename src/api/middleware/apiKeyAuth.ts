import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { hashApiKey, hashApiKeyPlain } from "../../utils/apiKey.js";
import { env } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:apiKeyAuth");

const KEY_SELECT = {
  id: true,
  status: true,
  monthlyRequestCount: true,
  monthlyResetAt: true,
  tenant: {
    select: { id: true, name: true, email: true, plan: true, status: true },
  },
} as const;

export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Prefer x-api-key header; fall back to Authorization: Bearer <key>
  // x-api-key takes priority because some endpoints send both x-api-key (tenant key)
  // and Authorization: Bearer (Clerk JWT) simultaneously — reading Authorization first
  // would cause the Clerk token to be treated as the API key and rejected.
  const authHeader = c.req.header("authorization");
  const raw =
    c.req.header("x-api-key")?.trim()
    ?? (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null)
    ?? null;

  if (!raw) {
    return c.json({ error: "Missing API key" }, 401);
  }

  // Primary lookup: HMAC-SHA256 hash (or plain SHA-256 when HMAC_KEY is unset)
  let apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: KEY_SELECT,
  });

  // Backward-compatible fallback: if HMAC_KEY is set and primary lookup missed,
  // try plain SHA-256 to support keys that were hashed before HMAC was introduced.
  if (!apiKey && env.HMAC_KEY) {
    apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKeyPlain(raw) },
      select: KEY_SELECT,
    });
  }

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
