import { describe, expect, test } from "bun:test";
import { createAccountRateLimiter } from "./paymaster-account-attribution.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";

describe("createAccountRateLimiter", () => {
  test("allows requests with no session header — attribution is additive, never a hard gate", () => {
    const limiter = createAccountRateLimiter(1);
    expect(limiter.check(undefined)).toBe(true);
    expect(limiter.check(undefined)).toBe(true);
  });

  test("allows requests with a malformed/invalid session header — fails open, not closed", () => {
    const limiter = createAccountRateLimiter(1);
    expect(limiter.check("not-a-real-token")).toBe(true);
    expect(limiter.check("not-a-real-token")).toBe(true);
  });

  test("rate-limits a single account once it exceeds its own per-minute cap", () => {
    const token = issueAccountSessionToken("acct_1");
    const limiter = createAccountRateLimiter(2);
    expect(limiter.check(token)).toBe(true);
    expect(limiter.check(token)).toBe(true);
    expect(limiter.check(token)).toBe(false);
  });

  test("one account hitting its cap doesn't affect another account", () => {
    const tokenA = issueAccountSessionToken("acct_a");
    const tokenB = issueAccountSessionToken("acct_b");
    const limiter = createAccountRateLimiter(1);
    expect(limiter.check(tokenA)).toBe(true);
    expect(limiter.check(tokenA)).toBe(false);
    expect(limiter.check(tokenB)).toBe(true);
  });
});
