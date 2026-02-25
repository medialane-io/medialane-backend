import type { MiddlewareHandler } from "hono";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("http");

export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  log.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms,
    },
    `${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`
  );
};
