import { describe, expect, test } from "bun:test";
import { createAccountRateLimiter } from "./paymaster-account-attribution.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { InMemoryRateLimitStore } from "../middleware/rateLimit.js";
import type { RateLimitStore } from "../middleware/rateLimit.js";

describe("createAccountRateLimiter", () => {
  test("rate-limits a single account once it exceeds its own per-minute cap", async () => {
    const sessionToken = issueAccountSessionToken("acct_1");
    const limiter = createAccountRateLimiter(2, new InMemoryRateLimitStore());
    expect(await limiter.check({ sessionToken })).toBe(true);
    expect(await limiter.check({ sessionToken })).toBe(true);
    expect(await limiter.check({ sessionToken })).toBe(false);
  });

  test("one account hitting its cap doesn't affect another account", async () => {
    const a = issueAccountSessionToken("acct_a");
    const b = issueAccountSessionToken("acct_b");
    const limiter = createAccountRateLimiter(1, new InMemoryRateLimitStore());
    expect(await limiter.check({ sessionToken: a })).toBe(true);
    expect(await limiter.check({ sessionToken: a })).toBe(false);
    expect(await limiter.check({ sessionToken: b })).toBe(true);
  });

  test("omitting the session no longer removes the cap", async () => {
    const limiter = createAccountRateLimiter(5, new InMemoryRateLimitStore(), 1);
    expect(await limiter.check({ address: "0xabc" })).toBe(true);
    expect(await limiter.check({ address: "0xabc" })).toBe(false);
  });

  test("an invalid session falls back to the wallet cap rather than passing", async () => {
    const limiter = createAccountRateLimiter(5, new InMemoryRateLimitStore(), 1);
    expect(await limiter.check({ sessionToken: "not-a-real-token", address: "0xabc" })).toBe(true);
    expect(await limiter.check({ sessionToken: "not-a-real-token", address: "0xabc" })).toBe(false);
  });

  test("the wallet cap is keyed per wallet, so one user cannot starve another", async () => {
    const limiter = createAccountRateLimiter(5, new InMemoryRateLimitStore(), 1);
    expect(await limiter.check({ address: "0xaaa" })).toBe(true);
    expect(await limiter.check({ address: "0xaaa" })).toBe(false);
    expect(await limiter.check({ address: "0xbbb" })).toBe(true);
  });

  test("wallet addresses are compared case-insensitively", async () => {
    const limiter = createAccountRateLimiter(5, new InMemoryRateLimitStore(), 1);
    expect(await limiter.check({ address: "0xABC" })).toBe(true);
    expect(await limiter.check({ address: "0xabc" })).toBe(false);
  });

  test("with neither session nor wallet, the caller address is the last resort key", async () => {
    const limiter = createAccountRateLimiter(5, new InMemoryRateLimitStore(), 1);
    expect(await limiter.check({ ip: "203.0.113.1" })).toBe(true);
    expect(await limiter.check({ ip: "203.0.113.1" })).toBe(false);
    expect(await limiter.check({ ip: "203.0.113.2" })).toBe(true);
  });

  test("a store that throws fails open instead of blocking a legitimate sponsored request", async () => {
    const sessionToken = issueAccountSessionToken("acct_1");
    const throwingStore: RateLimitStore = {
      async increment() {
        throw new Error("Redis unavailable");
      },
    };
    const limiter = createAccountRateLimiter(1, throwingStore);
    expect(await limiter.check({ sessionToken })).toBe(true);
  });
});
