import { test, expect } from "bun:test";
import { shouldRejectNewAccountForWallet } from "./account.js";

test("io wallet with no accountToken is rejected — must register with email first", () => {
  expect(shouldRejectNewAccountForWallet({ requireExistingAccountLink: true })).toBe(true);
});

test("io wallet with a valid accountToken is allowed — links to the registered account", () => {
  expect(shouldRejectNewAccountForWallet({
    requireExistingAccountLink: true,
    linkToAccountId: "acc_ABC123",
  })).toBe(false);
});

test("dapp/portal wallets are never rejected — no email requirement for those apps", () => {
  expect(shouldRejectNewAccountForWallet({ requireExistingAccountLink: false })).toBe(false);
  expect(shouldRejectNewAccountForWallet({})).toBe(false);
});
