import { test, expect } from "bun:test";
import { graceCutoff, deadlineFor, isPastDue, RULE_STARTS_AT } from "./unverifiedAccounts.js";
import { DEFAULT_GRACE_DAYS } from "../utils/emailVerification.js";

const NOW = new Date("2026-09-13T12:00:00.000Z");

test("an account has the same time to verify as the grace the rest of the platform gives", () => {
  const cutoff = graceCutoff(NOW);
  const days = (NOW.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);

  expect(days).toBe(DEFAULT_GRACE_DAYS);
});

test("an address registered inside the grace is left alone", () => {
  const registered = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

  expect(registered > graceCutoff(NOW)).toBe(true);
});

test("an address registered before the grace began is past due", () => {
  const registered = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);

  expect(registered < graceCutoff(NOW)).toBe(true);
});

test("nobody is asked for something that was not asked of them when they signed up", () => {
  const longBefore = new Date("2026-06-01T00:00:00.000Z");
  const yearsLater = new Date("2027-06-01T00:00:00.000Z");

  expect(isPastDue(longBefore, NOW)).toBe(false);
  expect(isPastDue(longBefore, yearsLater)).toBe(false);
});

test("somebody who signs up afterwards gets the grace from their own day", () => {
  const after = new Date(RULE_STARTS_AT.getTime() + 30 * 24 * 60 * 60 * 1000);
  const eightDaysLater = new Date(after.getTime() + 8 * 24 * 60 * 60 * 1000);

  expect(isPastDue(after, eightDaysLater)).toBe(true);
  expect(isPastDue(after, new Date(after.getTime() + 3 * 24 * 60 * 60 * 1000))).toBe(false);
});

test("the day the rule starts is the line, and an account registered on it is held to it", () => {
  const onTheDay = new Date(RULE_STARTS_AT.getTime() + 60 * 1000);
  const eightDaysLater = new Date(onTheDay.getTime() + 8 * 24 * 60 * 60 * 1000);

  expect(isPastDue(onTheDay, eightDaysLater)).toBe(true);
});
