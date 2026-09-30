import { test, expect } from "bun:test";
import { shouldBePrimaryWallet, defaultRolesForType } from "./account.js";

test("a wallet linked to an account that already has a primary does not become primary", () => {
  expect(shouldBePrimaryWallet(true)).toBe(false);
});

test("the first wallet on an account becomes its primary", () => {
  expect(shouldBePrimaryWallet(false)).toBe(true);
});

test("an agent account is created with the agent role", () => {
  expect(defaultRolesForType("AGENT")).toEqual(["AGENT"]);
});

test("an organization and a partner carry their own roles", () => {
  expect(defaultRolesForType("ORGANIZATION")).toEqual(["ORGANIZATION"]);
  expect(defaultRolesForType("PARTNER")).toEqual(["PARTNER"]);
});

test("a person starts with no roles, since creator and collector are earned", () => {
  expect(defaultRolesForType("PERSON")).toEqual([]);
});
