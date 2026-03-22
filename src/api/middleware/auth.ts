import { timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";
import type { AppEnv } from "../../types/hono.js";

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.req.header("x-api-key") ?? "";
  // Constant-time comparison — prevents timing attacks that brute-force the secret character by character
  const secretBuf = Buffer.from(env.API_SECRET_KEY);
  const keyBuf = Buffer.from(apiKey);
  const maxLen = Math.max(secretBuf.length, keyBuf.length);
  const a = Buffer.alloc(maxLen);
  const b = Buffer.alloc(maxLen);
  secretBuf.copy(a);
  keyBuf.copy(b);
  if (!timingSafeEqual(a, b)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("isAdmin", true);
  await next();
};
