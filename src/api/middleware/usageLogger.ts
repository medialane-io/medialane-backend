import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:usageLogger");

export const usageLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  await next();
  const latencyMs = Date.now() - start;

  const apiKey = c.get("apiKey");
  if (!apiKey) return;

  const url = new URL(c.req.url);

  // Fire-and-forget — never block the response
  prisma.usageLog
    .create({
      data: {
        tenantId: apiKey.tenant.id,
        apiKeyId: apiKey.id,
        method: c.req.method,
        path: url.pathname,
        statusCode: c.res.status,
        latencyMs,
      },
    })
    .catch((err) => log.warn({ err }, "Failed to write usage log"));
};
