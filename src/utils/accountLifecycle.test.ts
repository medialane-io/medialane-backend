import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  IO_VERIFICATION_DAYS,
  VERIFICATION_REMINDER_AFTER_DAYS,
  VERIFICATION_REMINDER_DAYS_BEFORE,
  reminderOpensAt,
  verificationDeadline,
} from "./accountLifecycle";

const CREATED = new Date("2026-10-01T12:00:00Z");

describe("the io sign-up deadline", () => {
  test("is seven days, and the reminder comes two days before it, on day five", () => {
    expect(IO_VERIFICATION_DAYS).toBe(7);
    expect(VERIFICATION_REMINDER_DAYS_BEFORE).toBe(2);
    expect(VERIFICATION_REMINDER_AFTER_DAYS).toBe(5);
  });

  test("the reminder always opens before the account expires", () => {
    expect(reminderOpensAt(CREATED).getTime()).toBeLessThan(verificationDeadline(CREATED).getTime());
  });

  test("the dates are counted from when the account was made", () => {
    expect(reminderOpensAt(CREATED).toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(verificationDeadline(CREATED).toISOString()).toBe("2026-10-08T12:00:00.000Z");
    expect(DAY_MS).toBe(86_400_000);
  });
});
