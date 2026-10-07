import { test, expect } from "bun:test";
import { canClaimEmail } from "./emailVerification.js";


test("canClaimEmail: no existing owner — allowed", () => {
  expect(canClaimEmail("acc_A", null)).toEqual({ allowed: true, reason: null });
});

test("canClaimEmail: caller already owns it — blocked, already-yours", () => {
  expect(canClaimEmail("acc_A", { accountId: "acc_A" })).toEqual({ allowed: false, reason: "already-yours" });
});

test("canClaimEmail: held by a different account — blocked, held-elsewhere", () => {
  expect(canClaimEmail("acc_A", { accountId: "acc_B" })).toEqual({ allowed: false, reason: "held-elsewhere" });
});
