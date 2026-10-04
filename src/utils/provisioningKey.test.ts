import { test, expect } from "bun:test";
import { computeAccountAddress } from "@medialane/sdk/starknet";
import { provisioningKeyWith } from "./provisioningKey.js";

const SECRET = "a".repeat(64);

test("the same account gives the same key", () => {
  expect(provisioningKeyWith(SECRET, "acc-1")).toEqual(provisioningKeyWith(SECRET, "acc-1"));
});

test("a different account gives a different key", () => {
  expect(provisioningKeyWith(SECRET, "acc-2").publicKey).not.toBe(provisioningKeyWith(SECRET, "acc-1").publicKey);
});

test("a different secret gives a different key", () => {
  expect(provisioningKeyWith("b".repeat(64), "acc-1").publicKey).not.toBe(provisioningKeyWith(SECRET, "acc-1").publicKey);
});

test("the wallet address is the Media Wallet address of the public key", () => {
  const key = provisioningKeyWith(SECRET, "acc-1");
  expect(key.walletAddress).toBe(computeAccountAddress(key.publicKey, 0));
});

test("refuses a missing or short secret", () => {
  expect(() => provisioningKeyWith("", "acc-1")).toThrow("PROVISIONING_SECRET is not configured");
  expect(() => provisioningKeyWith("short", "acc-1")).toThrow("PROVISIONING_SECRET is not configured");
});
