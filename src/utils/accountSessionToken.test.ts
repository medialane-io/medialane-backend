import { test, expect } from "bun:test";
import { issueAccountSessionToken, readAccountSession, sessionVerdict } from "./accountSessionToken";

const accountOf = (raw: string) => readAccountSession(raw)?.accountId ?? null;

test("issues a token that verifies back to the same accountId", () => {
  const token = issueAccountSessionToken("acc_ABC123");
  expect(token.startsWith("account_session_")).toBe(true);
  expect(accountOf(token)).toBe("acc_ABC123");
});

test("rejects a tampered token", () => {
  const token = issueAccountSessionToken("acc_ABC123");
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  expect(accountOf(tampered)).toBeNull();
});

test("rejects an expired token", () => {
  const realNow = Date.now;
  Date.now = () => realNow() - 31 * 24 * 60 * 60 * 1000;
  const token = issueAccountSessionToken("acc_ABC123");
  Date.now = realNow;
  expect(accountOf(token)).toBeNull();
});

test("does not reject a token that is 25 hours old (TTL is 30 days, not 24 hours)", () => {
  const realNow = Date.now;
  Date.now = () => realNow() - 25 * 60 * 60 * 1000;
  const token = issueAccountSessionToken("acc_ABC123");
  Date.now = realNow;
  expect(accountOf(token)).toBe("acc_ABC123");
});

test("rejects a malformed token", () => {
  expect(accountOf("not-a-real-token")).toBeNull();
  expect(accountOf("account_session_garbage")).toBeNull();
  expect(accountOf("")).toBeNull();
});

test("rejects a token with a different prefix", () => {
  expect(accountOf("email_verified_abc.def")).toBeNull();
});

const CUTOFF = new Date("2026-11-03T12:00:00Z");
const CUTOFF_SECONDS = CUTOFF.getTime() / 1000;

test("sessionVerdict refuses only an inactive account when there is no cutoff", () => {
  expect(sessionVerdict({ status: "ACTIVE", sessionsValidFrom: null }, CUTOFF_SECONDS)).toBe("ok");
  expect(sessionVerdict({ status: "PENDING", sessionsValidFrom: null }, CUTOFF_SECONDS)).toBe("ok");
  expect(sessionVerdict({ status: "INACTIVE", sessionsValidFrom: null }, CUTOFF_SECONDS)).toBe("inactive");
});

test("a session issued before the cutoff has ended", () => {
  expect(sessionVerdict({ status: "ACTIVE", sessionsValidFrom: CUTOFF }, CUTOFF_SECONDS - 1)).toBe("ended");
});

test("a session issued in the cutoff second is valid", () => {
  expect(sessionVerdict({ status: "ACTIVE", sessionsValidFrom: CUTOFF }, CUTOFF_SECONDS)).toBe("ok");
  expect(sessionVerdict({ status: "ACTIVE", sessionsValidFrom: CUTOFF }, CUTOFF_SECONDS + 3600)).toBe("ok");
});

test("an inactive account is inactive even with a cutoff", () => {
  expect(sessionVerdict({ status: "INACTIVE", sessionsValidFrom: CUTOFF }, CUTOFF_SECONDS - 1)).toBe("inactive");
});

test("a pending account follows the same cutoff", () => {
  expect(sessionVerdict({ status: "PENDING", sessionsValidFrom: CUTOFF }, CUTOFF_SECONDS - 1)).toBe("ended");
});
