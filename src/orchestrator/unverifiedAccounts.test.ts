import { test, expect } from "bun:test";
import { graceCutoff } from "./unverifiedAccounts.js";
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
