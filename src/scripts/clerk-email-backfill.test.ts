import { describe, expect, test } from "bun:test";
import { normalizeIdentityValue, planClerkEmailBackfill, type ClerkRow } from "./clerk-email-backfill.js";

const clerkIdentities = new Map([
  ["user_aaa", { accountId: "acct-1", tenantId: "tenant-io" }],
  ["user_bbb", { accountId: "acct-2", tenantId: "tenant-io" }],
]);

function plan(rows: ClerkRow[], emailOwners: Record<string, string> = {}) {
  return planClerkEmailBackfill(rows, clerkIdentities, new Map(Object.entries(emailOwners)));
}

describe("normalizeIdentityValue", () => {
  test("lowercases and trims an email", () => {
    expect(normalizeIdentityValue("email", "  Ana@Example.COM ")).toBe("ana@example.com");
  });

  test("reduces a phone number to digits with a country prefix", () => {
    expect(normalizeIdentityValue("phone", "+55 (11) 98765-4321")).toBe("+5511987654321");
  });

  test("leaves an unknown scheme alone apart from trimming", () => {
    expect(normalizeIdentityValue("clerk", "  user_AAA  ")).toBe("user_AAA");
  });
});

describe("planClerkEmailBackfill", () => {
  test("plans an email identity for a matched clerk account", () => {
    const [outcome] = plan([{ clerkUserId: "user_aaa", email: "Ana@Example.com" }]);
    expect(outcome).toEqual({
      kind: "create",
      accountId: "acct-1",
      tenantId: "tenant-io",
      email: "ana@example.com",
    });
  });

  test("reports a clerk id that has no identity in the database", () => {
    const [outcome] = plan([{ clerkUserId: "user_zzz", email: "zoe@example.com" }]);
    expect(outcome).toEqual({ kind: "unmatched", clerkUserId: "user_zzz" });
  });

  test("skips an account that already carries that email", () => {
    const [outcome] = plan(
      [{ clerkUserId: "user_aaa", email: "ana@example.com" }],
      { "ana@example.com": "acct-1" },
    );
    expect(outcome.kind).toBe("already_linked");
  });

  test("refuses to move an email that belongs to a different account", () => {
    const [outcome] = plan(
      [{ clerkUserId: "user_aaa", email: "ana@example.com" }],
      { "ana@example.com": "acct-other" },
    );
    expect(outcome).toEqual({
      kind: "conflict",
      email: "ana@example.com",
      clerkAccountId: "acct-1",
      otherAccountId: "acct-other",
    });
  });

  test("matches an existing email regardless of the case in the export", () => {
    const [outcome] = plan(
      [{ clerkUserId: "user_aaa", email: "ANA@EXAMPLE.COM" }],
      { "ana@example.com": "acct-1" },
    );
    expect(outcome.kind).toBe("already_linked");
  });

  test("flags the same email appearing twice in one export", () => {
    const outcomes = plan([
      { clerkUserId: "user_aaa", email: "shared@example.com" },
      { clerkUserId: "user_bbb", email: "shared@example.com" },
    ]);
    expect(outcomes[0].kind).toBe("create");
    expect(outcomes[1].kind).toBe("conflict");
  });

  test("ignores rows with no usable email", () => {
    expect(plan([{ clerkUserId: "user_aaa", email: "" }])).toEqual([]);
    expect(plan([{ clerkUserId: "user_aaa", email: "notanemail" }])).toEqual([]);
  });
});
