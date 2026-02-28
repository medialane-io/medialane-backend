import type { MiddlewareHandler } from "hono";
import type { TenantPlan } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";

const RATE_LIMITS: Record<TenantPlan, number> = {
  FREE: 60,
  PREMIUM: 3000,
};

const WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Store interface — swap to RedisRateLimitStore for multi-instance production
// ---------------------------------------------------------------------------
export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
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

// Singleton default store
const defaultStore = new InMemoryRateLimitStore();

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

    const limit = RATE_LIMITS[apiKey.tenant.plan] ?? RATE_LIMITS.FREE;
    const key = `ratelimit:${apiKey.id}`;

    const { count, resetAt } = await store.increment(key, WINDOW_MS);
    const remaining = Math.max(0, limit - count);
    const resetSec = Math.ceil(resetAt / 1000);

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSec));

    if (count > limit) {
      c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}
