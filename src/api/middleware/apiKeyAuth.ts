import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { hashApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:apiKeyAuth");

export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Accept Authorization: Bearer <key> or x-api-key: <key>
  // Query-param ?apiKey= was removed — API keys in URLs appear in access logs and browser history
  const authHeader = c.req.header("authorization");
  const raw =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim()
    : c.req.header("x-api-key")?.trim()
    ?? null;

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
