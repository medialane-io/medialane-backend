import { describe, expect, test } from "bun:test";
import { shouldAddEmailIdentity } from "./emailVerification.js";

describe("shouldAddEmailIdentity", () => {
  test("adds an email to an account that has none, when nobody holds it", () => {
    expect(shouldAddEmailIdentity({ emailHeldByAnyAccount: false, accountHasEmail: false })).toBe(true);
  });

  test("does not add a second email to an account that already has one", () => {
    expect(shouldAddEmailIdentity({ emailHeldByAnyAccount: false, accountHasEmail: true })).toBe(false);
  });

  test("does not add an email another identity already holds", () => {
    expect(shouldAddEmailIdentity({ emailHeldByAnyAccount: true, accountHasEmail: false })).toBe(false);
  });
});
