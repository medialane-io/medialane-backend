import { verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { defaultStore, type RateLimitStore } from "../middleware/rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:paymaster-account-attribution");

const WINDOW_MS = 60_000;

export interface AccountRateLimiter {
  // Returns false only when a *verified* account has exceeded its own cap.
  // A missing or invalid session is never a reason to reject — attribution
  // is additive on top of the existing per-apiClient/per-IP checks, not a
  // second gate (io's wallet-first onboarding calls these routes before any
  // account session cookie exists at all).
  check(sessionToken: string | undefined): Promise<boolean>;
}

export function createAccountRateLimiter(max: number = 20, store: RateLimitStore = defaultStore): AccountRateLimiter {
  return {
    async check(sessionToken) {
      if (!sessionToken) return true;
      const accountId = verifyAccountSessionToken(sessionToken);
      if (!accountId) return true;

      try {
        const { count } = await store.increment(`paymaster-account:${accountId}`, WINDOW_MS);
        return count <= max;
      } catch (err) {
        // Same rule as apiKeyRateLimit: this throttles abuse, it must never
        // be the reason a legitimate sponsored request fails.
        log.warn({ err }, "Account rate limit store unavailable, failing open");
        return true;
      }
    },
  };
}
