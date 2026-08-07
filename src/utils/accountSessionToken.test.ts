import { test, expect } from "bun:test";
import { issueAccountSessionToken, verifyAccountSessionToken } from "./accountSessionToken";

test("issues a token that verifies back to the same accountId", () => {
  const token = issueAccountSessionToken("acc_ABC123");
  expect(token.startsWith("account_session_")).toBe(true);
  expect(verifyAccountSessionToken(token)).toBe("acc_ABC123");
});

test("rejects a tampered token", () => {
  const token = issueAccountSessionToken("acc_ABC123");
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  expect(verifyAccountSessionToken(tampered)).toBeNull();
});

test("rejects an expired token", () => {
  const realNow = Date.now;
  Date.now = () => realNow() - 25 * 60 * 60 * 1000; // issue 25 hours in the past
  const token = issueAccountSessionToken("acc_ABC123");
  Date.now = realNow;
  expect(verifyAccountSessionToken(token)).toBeNull();
});

test("rejects a malformed token", () => {
  expect(verifyAccountSessionToken("not-a-real-token")).toBeNull();
  expect(verifyAccountSessionToken("account_session_garbage")).toBeNull();
  expect(verifyAccountSessionToken("")).toBeNull();
});

test("rejects an emailVerificationToken passed to the wrong verifier (different prefix)", () => {
  expect(verifyAccountSessionToken("email_verified_abc.def")).toBeNull();
});
