import { test, expect } from "bun:test";
import { isExpired, IO_VERIFICATION_DAYS, verificationDeadline } from "./unverifiedAccounts.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

test("an io email signup has seven days to verify", () => {
  expect(IO_VERIFICATION_DAYS).toBe(7);
});

test("a pending account inside the window is left alone", () => {
  expect(isExpired(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe(false);
});

test("a pending account past the window has expired", () => {
  expect(isExpired(new Date(NOW.getTime() - 8 * DAY), NOW)).toBe(true);
});

test("the deadline is exactly seven days after the account was made", () => {
  expect(verificationDeadline(new Date("2026-10-03T12:00:00Z")).toISOString()).toBe("2026-10-10T12:00:00.000Z");
});
