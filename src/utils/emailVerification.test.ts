import { test, expect } from "bun:test";
import { canClaimEmail } from "./emailVerification.js";


test("canClaimEmail: no existing owner — allowed", () => {
  expect(canClaimEmail("acc_A", null)).toEqual({ allowed: true, reason: null });
});

test("canClaimEmail: caller already owns it — blocked, already-yours", () => {
  const existingOwner = { accountId: "acc_A", verifiedAt: null };
  expect(canClaimEmail("acc_A", existingOwner)).toEqual({ allowed: false, reason: "already-yours" });
});

test("canClaimEmail: verified on a different account — blocked, verified-elsewhere", () => {
  const existingOwner = { accountId: "acc_B", verifiedAt: new Date("2026-01-01T00:00:00Z") };
  expect(canClaimEmail("acc_A", existingOwner)).toEqual({ allowed: false, reason: "verified-elsewhere" });
});

test("canClaimEmail: unverified on a different account — allowed, the stale claim can be reclaimed", () => {
  const existingOwner = { accountId: "acc_B", verifiedAt: null };
  expect(canClaimEmail("acc_A", existingOwner)).toEqual({ allowed: true, reason: null });
});
