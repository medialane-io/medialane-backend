import Redis from "ioredis";
import type { RateLimitStore } from "./rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:redisRateLimit");

const INCR_WITH_EXPIRY = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return {c, redis.call('PTTL', KEYS[1])}
`;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false });
    this.redis.on("error", (err: Error) => {

      log.error({ err: err.message }, "Redis error");
    });
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const redisKey = `rl:${key}`;

    const [count, pttl] = (await this.redis.eval(
      INCR_WITH_EXPIRY,
      1,
      redisKey,
      String(windowMs),
    )) as [number, number];

    const resetAt = Date.now() + (pttl > 0 ? pttl : windowMs);
    return { count, resetAt };
  }
}

export function createRedisStore(url: string): RedisRateLimitStore {
  return new RedisRateLimitStore(url);
}
