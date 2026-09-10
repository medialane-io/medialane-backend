import { test, expect } from "bun:test";

function callerMayTouch(intentAccountId: string | null, callerAccountId: string): boolean {
  return !(!intentAccountId || intentAccountId !== callerAccountId);
}

test("the owner may act on their own intent", () => {
  expect(callerMayTouch("acc_1", "acc_1")).toBe(true);
});

test("another account may not", () => {
  expect(callerMayTouch("acc_1", "acc_2")).toBe(false);
});

test("an ownerless intent belongs to nobody, so nobody may act on it", () => {

  expect(callerMayTouch(null, "acc_1")).toBe(false);
  expect(callerMayTouch(null, "acc_2")).toBe(false);
});
