import { test, expect } from "bun:test";
import { accountSessionIssuedAt, isSessionCurrent, issueAccountSessionToken, sessionVerdict, verifyAccountSessionToken } from "./accountSessionToken";

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
  Date.now = () => realNow() - 31 * 24 * 60 * 60 * 1000;
  const token = issueAccountSessionToken("acc_ABC123");
  Date.now = realNow;
  expect(verifyAccountSessionToken(token)).toBeNull();
});

test("does not reject a token that is 25 hours old (TTL is 30 days, not 24 hours)", () => {
  const realNow = Date.now;
  Date.now = () => realNow() - 25 * 60 * 60 * 1000;
  const token = issueAccountSessionToken("acc_ABC123");
  Date.now = realNow;
  expect(verifyAccountSessionToken(token)).toBe("acc_ABC123");
});

test("rejects a malformed token", () => {
  expect(verifyAccountSessionToken("not-a-real-token")).toBeNull();
  expect(verifyAccountSessionToken("account_session_garbage")).toBeNull();
  expect(verifyAccountSessionToken("")).toBeNull();
});

test("rejects a token with a different prefix", () => {
  expect(verifyAccountSessionToken("email_verified_abc.def")).toBeNull();
});

test("a session is current when the account has no cutoff", () => {
  expect(isSessionCurrent(1_000, null)).toBe(true);
  expect(isSessionCurrent(null, null)).toBe(true);
});

test("a session issued before the cutoff is not current, one issued at or after it is", () => {
  const cutoff = new Date(10_500_000);
  expect(isSessionCurrent(10_499, cutoff)).toBe(false);
  expect(isSessionCurrent(10_500, cutoff)).toBe(true);
  expect(isSessionCurrent(10_501, cutoff)).toBe(true);
});

test("a session with no readable issue time is not current once a cutoff exists", () => {
  expect(isSessionCurrent(null, new Date())).toBe(false);
});

test("a token issued now is current against a cutoff set just before it", () => {
  const cutoff = new Date();
  const token = issueAccountSessionToken("acc_ABC123");
  expect(isSessionCurrent(accountSessionIssuedAt(token), cutoff)).toBe(true);
});

test("sessionVerdict refuses an inactive account first, then a session older than the cutoff", () => {
  const token = issueAccountSessionToken("acc_ABC123");
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  expect(sessionVerdict({ status: "ACTIVE", sessionsValidFrom: null }, token)).toBe("ok");
  expect(sessionVerdict({ status: "PENDING", sessionsValidFrom: past }, token)).toBe("ok");
  expect(sessionVerdict({ status: "ACTIVE", sessionsValidFrom: future }, token)).toBe("expired");
  expect(sessionVerdict({ status: "INACTIVE", sessionsValidFrom: null }, token)).toBe("inactive");
  expect(sessionVerdict({ status: "INACTIVE", sessionsValidFrom: future }, token)).toBe("inactive");
});

