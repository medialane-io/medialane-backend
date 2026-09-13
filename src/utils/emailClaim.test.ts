import { test, expect } from "bun:test";
import { claimOutcome } from "./emailClaim.js";

const VERIFIED = {
  id: "idn_1",
  accountId: "acc_1",
  verifiedAt: new Date(),
  accountStatus: "ACTIVE" as const,
};

test("an address nobody holds is free to claim", () => {
  expect(claimOutcome(null)).toBe("none");
});

test("an address someone proved stays theirs, whatever their account's state", () => {
  expect(claimOutcome(VERIFIED)).toBe("own");
  expect(claimOutcome({ ...VERIFIED, accountStatus: "SUSPENDED" })).toBe("own");
});

test("an address still inside its grace stays with the account holding it", () => {
  expect(claimOutcome({ ...VERIFIED, verifiedAt: null })).toBe("own");
});

test("an address never proved, on an account that ran out of time, is released", () => {
  expect(claimOutcome({ ...VERIFIED, verifiedAt: null, accountStatus: "SUSPENDED" })).toBe("release");
});
