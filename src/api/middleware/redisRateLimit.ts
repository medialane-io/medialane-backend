import Redis from "ioredis";
import type { RateLimitStore } from "./rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:redisRateLimit");

// INCR the key, set the window TTL only on the first hit, and return
// [count, pttl]. Atomic on the server — no INCR/EXPIRE race.
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
      // log but don't crash — rate limiter should degrade gracefully
      log.error({ err: err.message }, "Redis error");
    });
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const redisKey = `rl:${key}`;
    // Atomic INCR + set-expiry-if-new + read TTL in one round trip. A pipeline
    // can't do this safely: if the process dies between INCR and a follow-up
    // PEXPIRE, the key lives forever with no TTL and that API key is stuck at
    // its accumulated count. The Lua body runs indivisibly on the server.
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
