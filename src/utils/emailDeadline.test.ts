import { describe, expect, test } from "bun:test";
import { emailDeadlineFor } from "./emailDeadline";

const CREATED = new Date("2026-10-01T12:00:00Z");
const pending = { status: "PENDING" as const, createdAt: CREATED, hasEmail: true };

describe("the date by which an email must be confirmed", () => {
  test("a pending sign-up with an email has until seven days after it was made", () => {
    expect(emailDeadlineFor(pending)?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  test("there is none when there is no email", () => {
    expect(emailDeadlineFor({ ...pending, hasEmail: false })).toBeNull();
  });

  test("there is none for an account that does not expire: open accounts, such as business-provisioned ones, and closed ones", () => {
    expect(emailDeadlineFor({ ...pending, status: "ACTIVE" })).toBeNull();
    expect(emailDeadlineFor({ ...pending, status: "INACTIVE" })).toBeNull();
  });
});
