
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { hashApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:apiKeyAuth");

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

function touchLastUsed(keyId: string): void {
  const now = Date.now();
  if (now - (lastUsedWrites.get(keyId) ?? 0) < LAST_USED_WRITE_INTERVAL_MS) return;
  lastUsedWrites.set(keyId, now);

  prisma.apiKey
    .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch((err) => log.warn({ err }, "Failed to update lastUsedAt"));
}

const KEY_SELECT = {
  id: true,
  prefix: true,
  status: true,
  apiClient: {
    select: {
      id: true,
      accountId: true,
      plan: true,
      creditBalance: true,
      account: { select: { id: true, status: true } },
    },
  },
} as const;

export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {

  const authHeader = c.req.header("authorization");
  const raw =
    c.req.header("x-api-key")?.trim()
    ?? (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null)
    ?? null;

  if (!raw) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: KEY_SELECT,
  });

  if (!apiKey || apiKey.status !== "ACTIVE" || !apiKey.apiClient || apiKey.apiClient.account.status !== "ACTIVE") {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }

  touchLastUsed(apiKey.id);

  c.set("apiKey", { id: apiKey.id, status: apiKey.status, apiClient: apiKey.apiClient });
  c.set("account", apiKey.apiClient.account);
  c.set("apiClient", apiKey.apiClient);

  await next();
};
