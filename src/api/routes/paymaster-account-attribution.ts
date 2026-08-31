import { verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { defaultStore, type RateLimitStore } from "../middleware/rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:paymaster-account-attribution");

const WINDOW_MS = 60_000;

export interface RateLimitSubject {
  sessionToken?: string;
  address?: string;
  ip?: string;
}

export interface AccountRateLimiter {
  check(subject: RateLimitSubject): Promise<boolean>;
}

export function createAccountRateLimiter(
  max: number = 20,
  store: RateLimitStore = defaultStore,
  unattributedMax: number = 20,
): AccountRateLimiter {
  return {
    async check({ sessionToken, address, ip }) {
      const accountId = sessionToken ? verifyAccountSessionToken(sessionToken) : null;

      let bucket: string;
      let limit: number;
      if (accountId) {
        bucket = `paymaster-account:${accountId}`;
        limit = max;
      } else if (address) {
        bucket = `paymaster-wallet:${address.toLowerCase()}`;
        limit = unattributedMax;
      } else {
        bucket = `paymaster-ip:${ip ?? "unknown"}`;
        limit = unattributedMax;
      }

      try {
        const { count } = await store.increment(bucket, WINDOW_MS);
        return count <= limit;
      } catch (err) {
        log.warn({ err }, "Account rate limit store unavailable, failing open");
        return true;
      }
    },
  };
}
