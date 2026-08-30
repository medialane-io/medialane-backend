import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { defaultStore, type RateLimitStore } from "./rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:clientIpRateLimit");

const WINDOW_MS = 60_000;

// Deliberately loose, because an address is not a person. Carrier-grade NAT and
// venue wifi put many real users behind one address, which is exactly the shape
// of the Rock in Rio traffic this is being tuned for, so a tight cap here reads
// as an outage to a crowd rather than as protection. Abuse is bounded below
// this by the per-key limit and, finally, by credits; this only stops one
// address monopolising the app's whole allowance.
const PER_CLIENT_LIMIT = 1200;

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
