import Redis from "ioredis";
import type { RateLimitStore } from "./rateLimit.js";

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false });
    this.redis.on("error", (err: Error) => {
      // log but don't crash — rate limiter should degrade gracefully
      console.error("[RedisRateLimitStore] Redis error:", err.message);
    });
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const redisKey = `rl:${key}`;
    // Atomic: INCR + PTTL (only set expiry on first increment)
    const pipeline = this.redis.pipeline();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);
    const results = await pipeline.exec();

    const count = (results?.[0]?.[1] as number) ?? 1;
    const pttl = (results?.[1]?.[1] as number) ?? -1;

    // Set expiry only if key is new (pttl === -1 means no expiry set)
    if (pttl === -1) {
      await this.redis.pexpire(redisKey, windowMs);
    }

    const resetAt = Date.now() + (pttl > 0 ? pttl : windowMs);
    return { count, resetAt };
  }
}

export function createRedisStore(url: string): RedisRateLimitStore {
  return new RedisRateLimitStore(url);
}
