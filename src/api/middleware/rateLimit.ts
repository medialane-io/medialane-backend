import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createRedisStore } from "./redisRateLimit.js";
import { createLogger } from "../../utils/logger.js";

import { env } from "../../config/env.js";

const log = createLogger("middleware:rateLimit");

const PER_MINUTE_LIMIT = 3000;
const WINDOW_MS = 60_000;

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

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

    if (this.map.size > 50_000) {
      for (const [k, e] of this.map) {
        if (now >= e.resetAt) this.map.delete(k);
      }
    }

    return { count: entry.count, resetAt: entry.resetAt };
  }
}

export class FallbackRateLimitStore implements RateLimitStore {
  private readonly local = new InMemoryRateLimitStore();

  constructor(private readonly primary: RateLimitStore) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    try {
      return await this.primary.increment(key, windowMs);
    } catch (err) {
      log.warn({ err }, "Rate limit store unavailable, falling back to per-instance counting");
      return this.local.increment(key, windowMs);
    }
  }
}

export const defaultStore: RateLimitStore = env.REDIS_URL
  ? new FallbackRateLimitStore(createRedisStore(env.REDIS_URL))
  : new InMemoryRateLimitStore();

export function apiKeyRateLimit(store: RateLimitStore = defaultStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const apiKey = c.get("apiKey");

    if (!apiKey) {
      await next();
      return;
    }

    const key = `ratelimit:${apiKey.id}`;
    let result: { count: number; resetAt: number };
    try {
      result = await store.increment(key, WINDOW_MS);
    } catch (err) {
      log.warn({ err }, "Rate limit store unavailable, failing open");
      await next();
      return;
    }
    const { count, resetAt } = result;
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
