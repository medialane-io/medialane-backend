import { timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";
import type { AppEnv } from "../../types/hono.js";

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") ?? "";
  const secretBuf = Buffer.from(env.API_SECRET_KEY);
  const keyBuf = Buffer.from(apiKey);
  // Lengths must match for timingSafeEqual — early reject on mismatch is acceptable
  // here because the secret length is not itself sensitive information.
  if (
    secretBuf.length !== keyBuf.length ||
    !timingSafeEqual(secretBuf, keyBuf)
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("isAdmin", true);
  await next();
};
