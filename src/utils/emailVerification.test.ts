import { test, expect } from "bun:test";
import { isEmailVerificationRequired } from "./emailVerification.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-15T00:00:00Z");

test("no email identity on file — not required", () => {
  expect(isEmailVerificationRequired(null, 7, NOW)).toBe(false);
});

test("verified email — not required, regardless of age", () => {
  const identity = { verifiedAt: new Date("2026-01-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") };
  expect(isEmailVerificationRequired(identity, 7, NOW)).toBe(false);
});

test("unverified, created 3 days ago (within 7-day grace) — not required", () => {
  const identity = { verifiedAt: null, createdAt: new Date(NOW.getTime() - 3 * DAY_MS) };
  expect(isEmailVerificationRequired(identity, 7, NOW)).toBe(false);
});

test("unverified, created exactly 7 days ago — not required (boundary is exclusive of the deadline itself)", () => {
  const identity = { verifiedAt: null, createdAt: new Date(NOW.getTime() - 7 * DAY_MS) };
  expect(isEmailVerificationRequired(identity, 7, NOW)).toBe(false);
});

test("unverified, created 8 days ago (past 7-day grace) — required", () => {
  const identity = { verifiedAt: null, createdAt: new Date(NOW.getTime() - 8 * DAY_MS) };
  expect(isEmailVerificationRequired(identity, 7, NOW)).toBe(true);
});

test("unverified, past grace, custom graceDays — respects the override", () => {
  const identity = { verifiedAt: null, createdAt: new Date(NOW.getTime() - 2 * DAY_MS) };
  expect(isEmailVerificationRequired(identity, 1, NOW)).toBe(true);
});
