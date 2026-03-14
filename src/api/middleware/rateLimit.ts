import type { MiddlewareHandler } from "hono";
import type { TenantPlan } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { createRedisStore } from "./redisRateLimit.js";

import { env } from "../../config/env.js";

const FREE_MONTHLY_LIMIT = 50;
const PREMIUM_PER_MINUTE_LIMIT = 3000;
const WINDOW_MS = 60_000; // 1 minute (PREMIUM only)

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

    const plan: TenantPlan = apiKey.tenant.plan;

    if (plan === "FREE") {
      const now = new Date();
      const resetAt = new Date(apiKey.monthlyResetAt);
      const isNewMonth =
        now.getFullYear() !== resetAt.getFullYear() ||
        now.getMonth() !== resetAt.getMonth();

      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const resetSec = Math.ceil(nextMonth.getTime() / 1000);

      if (isNewMonth) {
        prisma.apiKey
          .update({ where: { id: apiKey.id }, data: { monthlyRequestCount: 1, monthlyResetAt: now } })
          .catch(() => {});
      } else if (apiKey.monthlyRequestCount >= FREE_MONTHLY_LIMIT) {
        c.header("X-RateLimit-Limit", String(FREE_MONTHLY_LIMIT));
        c.header("X-RateLimit-Remaining", "0");
        c.header("X-RateLimit-Reset", String(resetSec));
        c.header("Retry-After", String(resetSec - Math.floor(Date.now() / 1000)));
        return c.json(
          { error: "Monthly request limit reached. Upgrade to PREMIUM for unlimited access." },
          429
        );
      } else {
        prisma.apiKey
          .update({ where: { id: apiKey.id }, data: { monthlyRequestCount: { increment: 1 } } })
          .catch(() => {});
      }

      c.header("X-RateLimit-Limit", String(FREE_MONTHLY_LIMIT));
      c.header(
        "X-RateLimit-Remaining",
        String(Math.max(0, FREE_MONTHLY_LIMIT - (isNewMonth ? 1 : apiKey.monthlyRequestCount + 1)))
      );
      c.header("X-RateLimit-Reset", String(resetSec));
    } else {
      // PREMIUM — per-minute in-memory limiting
      const key = `ratelimit:${apiKey.id}`;
      const { count, resetAt } = await store.increment(key, WINDOW_MS);
      const remaining = Math.max(0, PREMIUM_PER_MINUTE_LIMIT - count);
      const resetSec = Math.ceil(resetAt / 1000);

      c.header("X-RateLimit-Limit", String(PREMIUM_PER_MINUTE_LIMIT));
      c.header("X-RateLimit-Remaining", String(remaining));
      c.header("X-RateLimit-Reset", String(resetSec));

      if (count > PREMIUM_PER_MINUTE_LIMIT) {
        c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
        return c.json({ error: "Too many requests" }, 429);
      }
    }

    await next();
  };
}
