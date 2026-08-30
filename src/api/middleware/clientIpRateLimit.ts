import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { defaultStore, type RateLimitStore } from "./rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:clientIpRateLimit");

const WINDOW_MS = 60_000;
const PER_CLIENT_LIMIT = 600;

const TRUSTED_APP_HEADER = "x-medialane-client-ip";

/**
 * Caps a single end user, where the per-key limit only caps a whole app.
 *
 * This deliberately does nothing unless a first-party app proxy identified the
 * caller. Without that header the request is a direct API consumer, which
 * legitimately arrives from one address at volume, and per-IP counting would
 * punish it for being a server. Those are bounded by the per-key limit and by
 * credits instead.
 *
 * It lives here rather than in the apps because the shared store lives here.
 * An app doing this in memory gets one counter per serverless instance, so its
 * effective limit rises with the concurrency its hosting plan buys.
 */
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
