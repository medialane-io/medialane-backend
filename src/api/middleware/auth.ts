import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const apiKey = c.req.header("x-api-key");
  if (apiKey !== env.API_SECRET_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};
