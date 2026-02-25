import type { MiddlewareHandler } from "hono";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * In-process token bucket rate limiter keyed by IP.
 * Suitable for single-instance deployments. For multi-instance, replace
 * the store with a Redis-backed implementation.
 */
export function rateLimit(opts: {
  /** Max requests per window */
  limit: number;
  /** Window duration in ms */
  windowMs: number;
}): MiddlewareHandler {
  const store = new Map<string, Bucket>();

  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const now = Date.now();
    let bucket = store.get(ip);

    if (!bucket || now - bucket.lastRefill >= opts.windowMs) {
      bucket = { tokens: opts.limit, lastRefill: now };
    }

    if (bucket.tokens <= 0) {
      return c.json(
        { error: "Too many requests", retryAfter: opts.windowMs / 1000 },
        429
      );
    }

    bucket.tokens -= 1;
    store.set(ip, bucket);

    // Periodic cleanup to prevent unbounded memory growth
    if (store.size > 10_000) {
      for (const [key, b] of store) {
        if (now - b.lastRefill >= opts.windowMs * 2) store.delete(key);
      }
    }

    await next();
  };
}
