import { describe, expect, test } from "bun:test";
import { createAccountRateLimiter } from "./paymaster-account-attribution.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { InMemoryRateLimitStore } from "../middleware/rateLimit.js";
import type { RateLimitStore } from "../middleware/rateLimit.js";

describe("createAccountRateLimiter", () => {
  test("allows requests with no session header — attribution is additive, never a hard gate", async () => {
    const limiter = createAccountRateLimiter(1, new InMemoryRateLimitStore());
    expect(await limiter.check(undefined)).toBe(true);
    expect(await limiter.check(undefined)).toBe(true);
  });

  test("allows requests with a malformed/invalid session header — fails open, not closed", async () => {
    const limiter = createAccountRateLimiter(1, new InMemoryRateLimitStore());
    expect(await limiter.check("not-a-real-token")).toBe(true);
    expect(await limiter.check("not-a-real-token")).toBe(true);
  });

  test("rate-limits a single account once it exceeds its own per-minute cap", async () => {
    const token = issueAccountSessionToken("acct_1");
    const limiter = createAccountRateLimiter(2, new InMemoryRateLimitStore());
    expect(await limiter.check(token)).toBe(true);
    expect(await limiter.check(token)).toBe(true);
    expect(await limiter.check(token)).toBe(false);
  });

  test("one account hitting its cap doesn't affect another account", async () => {
    const tokenA = issueAccountSessionToken("acct_a");
    const tokenB = issueAccountSessionToken("acct_b");
    const limiter = createAccountRateLimiter(1, new InMemoryRateLimitStore());
    expect(await limiter.check(tokenA)).toBe(true);
    expect(await limiter.check(tokenA)).toBe(false);
    expect(await limiter.check(tokenB)).toBe(true);
  });

  test("a store that throws fails open instead of blocking a legitimate sponsored request", async () => {
    const token = issueAccountSessionToken("acct_1");
    const throwingStore: RateLimitStore = {
      async increment() {
        throw new Error("Redis unavailable");
      },
    };
    const limiter = createAccountRateLimiter(1, throwingStore);
    expect(await limiter.check(token)).toBe(true);
  });
});
