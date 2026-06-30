import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createRedisStore } from "./redisRateLimit.js";

import { env } from "../../config/env.js";

const PER_MINUTE_LIMIT = 3000;
const WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Store interface — swap to RedisRateLimitStore for multi-instance production
// ---------------------------------------------------------------------------
export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (used for PREMIUM per-minute limiting)
// ---------------------------------------------------------------------------
interface Entry {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, Entry>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    let entry = this.map.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
    } else {
      entry.count += 1;
    }

    this.map.set(key, entry);

    // Cleanup when store grows large
    if (this.map.size > 50_000) {
      for (const [k, e] of this.map) {
        if (now >= e.resetAt) this.map.delete(k);
      }
    }

    return { count: entry.count, resetAt: entry.resetAt };
  }
}

// Singleton store for PREMIUM per-minute rate limiting
const defaultStore: RateLimitStore = env.REDIS_URL
  ? createRedisStore(env.REDIS_URL)
  : new InMemoryRateLimitStore();

// ---------------------------------------------------------------------------
// Middleware factory — keyed by API key ID (not IP)
// ---------------------------------------------------------------------------
export function apiKeyRateLimit(store: RateLimitStore = defaultStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const apiKey = c.get("apiKey");

    // If auth hasn't run yet, skip rate limiting (shouldn't happen in normal wiring)
    if (!apiKey) {
      await next();
      return;
    }

    const key = `ratelimit:${apiKey.id}`;
    const { count, resetAt } = await store.increment(key, WINDOW_MS);
    const remaining = Math.max(0, PER_MINUTE_LIMIT - count);
    const resetSec = Math.ceil(resetAt / 1000);

    c.header("X-RateLimit-Limit", String(PER_MINUTE_LIMIT));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSec));

    if (count > PER_MINUTE_LIMIT) {
      c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}
