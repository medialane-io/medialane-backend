import { test, expect } from "bun:test";

type Ctx = { accountId: string | null; emailUnverified: boolean; hasUsername: boolean };

function claimRejection(ctx: Ctx): { status: number; reason: string } | null {
  if (!ctx.accountId) return { status: 403, reason: "no account" };
  if (ctx.emailUnverified) return { status: 403, reason: "email unverified" };
  if (ctx.hasUsername) return { status: 409, reason: "already has one" };
  return null;
}

const base: Ctx = { accountId: "acc_1", emailUnverified: false, hasUsername: false };

test("a wallet with no account cannot claim, so the email gate cannot be skipped", () => {
  expect(claimRejection({ ...base, accountId: null })).toEqual({ status: 403, reason: "no account" });
});

test("an unlinked wallet is refused even when everything else looks fine", () => {

  expect(claimRejection({ accountId: null, emailUnverified: false, hasUsername: false })).not.toBeNull();
});

test("an account with an unverified email cannot claim", () => {
  expect(claimRejection({ ...base, emailUnverified: true })?.status).toBe(403);
});

test("an account that already holds a username cannot claim another", () => {
  expect(claimRejection({ ...base, hasUsername: true })?.status).toBe(409);
});

test("a verified account without a username may claim", () => {
  expect(claimRejection(base)).toBeNull();
});

test("the account check runs before the email check, so the reason is never misleading", () => {
  expect(claimRejection({ accountId: null, emailUnverified: true, hasUsername: true })?.reason).toBe("no account");
});
