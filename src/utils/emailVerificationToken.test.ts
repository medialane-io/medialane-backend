import { test, expect } from "bun:test";
import { issueEmailVerifiedToken, verifyEmailVerifiedToken } from "./emailVerificationToken";

test("issues a token that verifies back to the same email", () => {
  const token = issueEmailVerifiedToken("alice@example.com");
  expect(token.startsWith("email_verified_")).toBe(true);
  expect(verifyEmailVerifiedToken(token)).toBe("alice@example.com");
});

test("rejects a tampered token", () => {
  const token = issueEmailVerifiedToken("alice@example.com");
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  expect(verifyEmailVerifiedToken(tampered)).toBeNull();
});

test("rejects an expired token", () => {
  const realNow = Date.now;
  Date.now = () => realNow() - 11 * 60 * 1000;
  const token = issueEmailVerifiedToken("alice@example.com");
  Date.now = realNow;
  expect(verifyEmailVerifiedToken(token)).toBeNull();
});

test("rejects a malformed token", () => {
  expect(verifyEmailVerifiedToken("not-a-real-token")).toBeNull();
  expect(verifyEmailVerifiedToken("email_verified_garbage")).toBeNull();
  expect(verifyEmailVerifiedToken("")).toBeNull();
});

test("rejects a SIWS token passed to the wrong verifier (different prefix)", () => {
  expect(verifyEmailVerifiedToken("siws_abc.def")).toBeNull();
});
