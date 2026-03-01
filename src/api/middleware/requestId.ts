import { randomUUID } from "crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";

/**
 * Generates a UUID per request, stores it in Hono context, and echoes it
 * back in the X-Request-Id response header so callers can correlate log lines.
 */
export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Honour an upstream-supplied ID (e.g. from a gateway or test client) or generate a fresh one
  const id = (c.req.header("x-request-id") ?? randomUUID()) as string;
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};
