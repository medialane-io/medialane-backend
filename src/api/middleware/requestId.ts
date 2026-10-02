import { randomUUID } from "crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {

  const supplied = c.req.header("x-request-id");
  const id = supplied && /^[\w.-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};
