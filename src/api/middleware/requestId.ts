import { randomUUID } from "crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {

  const id = (c.req.header("x-request-id") ?? randomUUID()) as string;
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};
