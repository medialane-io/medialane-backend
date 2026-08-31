import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { defaultStore, type RateLimitStore } from "./rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:clientIpRateLimit");

const WINDOW_MS = 60_000;

const PER_CLIENT_LIMIT = 1200;

const TRUSTED_APP_HEADER = "x-medialane-client-ip";

export function clientIpRateLimit(
  store: RateLimitStore = defaultStore,
  max: number = PER_CLIENT_LIMIT,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const clientIp = c.req.header(TRUSTED_APP_HEADER)?.trim();
    if (!clientIp) return next();

    const apiKey = c.get("apiKey");
    const bucket = `ratelimit:client-ip:${apiKey?.id ?? "anon"}:${clientIp}`;

    let count: number;
    try {
      ({ count } = await store.increment(bucket, WINDOW_MS));
    } catch (err) {
      log.warn({ err }, "Client-IP rate limit store unavailable, allowing");
      return next();
    }

    if (count > max) {
      log.warn({ clientIp, apiKey: apiKey?.id }, "client-IP rate limit hit");
      return c.json({ error: "Too many requests" }, 429);
    }

    return next();
  };
}
