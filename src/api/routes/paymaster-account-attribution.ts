import { createRateLimiter } from "@medialane/sdk";
import { verifyAccountSessionToken } from "../../utils/accountSessionToken.js";

const WINDOW_MS = 60_000;

export interface AccountRateLimiter {
  // Returns false only when a *verified* account has exceeded its own cap.
  // A missing or invalid session is never a reason to reject — attribution
  // is additive on top of the existing per-apiClient/per-IP checks, not a
  // second gate (io's wallet-first onboarding calls these routes before any
  // account session cookie exists at all).
  check(sessionToken: string | undefined): boolean;
}

export function createAccountRateLimiter(max: number = 20): AccountRateLimiter {
  const checkRateLimit = createRateLimiter(WINDOW_MS, max);
  return {
    check(sessionToken) {
      if (!sessionToken) return true;
      const accountId = verifyAccountSessionToken(sessionToken);
      if (!accountId) return true;
      return checkRateLimit(accountId);
    },
  };
}
