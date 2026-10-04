import { test, expect } from "bun:test";
import { shouldBePrimaryWallet } from "./account.js";

test("a wallet linked to an account that already has a primary does not become primary", () => {
  expect(shouldBePrimaryWallet(true)).toBe(false);
});

test("the first wallet on an account becomes its primary", () => {
  expect(shouldBePrimaryWallet(false)).toBe(true);
});
