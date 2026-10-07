import { test, expect } from "bun:test";
import { claimOutcome } from "./emailClaim.js";

const HELD = {
  id: "idn_1",
  accountId: "acc_1",
  accountStatus: "ACTIVE" as const,
};

test("an address nobody holds is free to claim", () => {
  expect(claimOutcome(null)).toBe("none");
});

test("an address stays with an open or pending account holding it", () => {
  expect(claimOutcome(HELD)).toBe("own");
  expect(claimOutcome({ ...HELD, accountStatus: "PENDING" })).toBe("own");
});

test("an address on an account that ran out of time is released", () => {
  expect(claimOutcome({ ...HELD, accountStatus: "INACTIVE" })).toBe("release");
});
