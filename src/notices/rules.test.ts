import { describe, expect, test } from "bun:test";
import { reminderDue, type ReminderFacts } from "./rules";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");
const ageDays = (days: number) => new Date(NOW.getTime() - days * DAY);

const due: ReminderFacts = {
  status: "PENDING",
  createdAt: ageDays(5),
  isIo: true,
  hasEmail: true,
  hasWallet: true,
};

describe("who gets the verification reminder", () => {
  test("an io sign-up with a wallet and an email, still pending, exactly five days old", () => {
    expect(reminderDue(due, NOW)).toBe(true);
  });

  test("and at any age up to the deadline", () => {
    expect(reminderDue({ ...due, createdAt: ageDays(6) }, NOW)).toBe(true);
    expect(reminderDue({ ...due, createdAt: ageDays(6.99) }, NOW)).toBe(true);
  });

  test("not before day five", () => {
    expect(reminderDue({ ...due, createdAt: ageDays(4.99) }, NOW)).toBe(false);
    expect(reminderDue({ ...due, createdAt: ageDays(1) }, NOW)).toBe(false);
  });

  test("not once the account is due to close", () => {
    expect(reminderDue({ ...due, createdAt: ageDays(7) }, NOW)).toBe(false);
    expect(reminderDue({ ...due, createdAt: ageDays(9) }, NOW)).toBe(false);
  });

  test("not for an account that is already open or already closed", () => {
    expect(reminderDue({ ...due, status: "ACTIVE" }, NOW)).toBe(false);
    expect(reminderDue({ ...due, status: "INACTIVE" }, NOW)).toBe(false);
  });

  test("not for someone who never finished onboarding (no wallet) or has no email", () => {
    expect(reminderDue({ ...due, hasWallet: false }, NOW)).toBe(false);
    expect(reminderDue({ ...due, hasEmail: false }, NOW)).toBe(false);
  });

  test("not for another client's account", () => {
    expect(reminderDue({ ...due, isIo: false }, NOW)).toBe(false);
  });

  test("a business-provisioned account is never reminded: it is ACTIVE from the start", () => {
    const provisioned: ReminderFacts = { ...due, status: "ACTIVE", createdAt: ageDays(6) };
    expect(reminderDue(provisioned, NOW)).toBe(false);
  });
});
