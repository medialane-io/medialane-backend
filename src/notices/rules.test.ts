import { describe, expect, test } from "bun:test";
import { reminderDue, welcomeDue, type ReminderFacts, type WelcomeFacts } from "./rules";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");
const ageDays = (days: number) => new Date(NOW.getTime() - days * DAY);

const due: ReminderFacts = {
  status: "PENDING",
  createdAt: ageDays(5),
  isIo: true,
  hasEmail: true,
  emailVerified: false,
  hasWallet: true,
};

describe("who gets the verification reminder", () => {
  test("an io sign-up with a wallet and an unconfirmed email, exactly five days old", () => {
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

  test("not for an account that is already open and verified, or already closed", () => {
    expect(reminderDue({ ...due, emailVerified: true }, NOW)).toBe(false);
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

  test("a business-provisioned account is never reminded: it is ACTIVE with an email nobody has confirmed yet", () => {
    const provisioned: ReminderFacts = { ...due, status: "ACTIVE", emailVerified: false, createdAt: ageDays(6) };
    expect(reminderDue(provisioned, NOW)).toBe(false);
  });
});

describe("who gets the welcome email", () => {
  const welcome: WelcomeFacts = {
    status: "PENDING",
    createdAt: ageDays(0.01),
    isIo: true,
    hasEmail: true,
    emailVerified: false,
    hasWallet: true,
  };

  test("a first-try signup: pending, with a wallet and an email nobody has confirmed yet", () => {
    expect(welcomeDue(welcome, NOW)).toBe(true);
  });

  test("someone who came back with a code: open and verified, with a wallet", () => {
    expect(welcomeDue({ ...welcome, status: "ACTIVE", emailVerified: true }, NOW)).toBe(true);
  });

  test("a provisioned account before its first sign-in: open but its email is not verified yet", () => {
    expect(welcomeDue({ ...welcome, status: "ACTIVE", emailVerified: false }, NOW)).toBe(false);
  });

  test("the same provisioned account once it has signed in with the code", () => {
    expect(welcomeDue({ ...welcome, status: "ACTIVE", emailVerified: true }, NOW)).toBe(true);
  });

  test("not without a wallet, an email, or io as the client, and never for a closed account", () => {
    expect(welcomeDue({ ...welcome, hasWallet: false }, NOW)).toBe(false);
    expect(welcomeDue({ ...welcome, hasEmail: false }, NOW)).toBe(false);
    expect(welcomeDue({ ...welcome, isIo: false }, NOW)).toBe(false);
    expect(welcomeDue({ ...welcome, status: "INACTIVE", emailVerified: true }, NOW)).toBe(false);
  });

  test("only within a week of the account being made, so an old account is never welcomed late", () => {
    expect(welcomeDue({ ...welcome, createdAt: ageDays(6.9) }, NOW)).toBe(true);
    expect(welcomeDue({ ...welcome, createdAt: ageDays(7) }, NOW)).toBe(false);
    expect(welcomeDue({ ...welcome, status: "ACTIVE", emailVerified: true, createdAt: ageDays(30) }, NOW)).toBe(false);
  });
});
