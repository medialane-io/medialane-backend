import { test, expect } from "bun:test";
import { computeAccountAddress } from "@medialane/sdk/starknet";
import { provisioningKeyWith } from "./provisioningKey.js";

const SECRET = "a".repeat(64);
const input = { apiClientId: "client-1", recipientScheme: "email", recipientValue: "ana@example.com", salt: "0123456789abcdef" };

test("the same inputs give the same key", () => {
  expect(provisioningKeyWith(SECRET, input)).toEqual(provisioningKeyWith(SECRET, input));
});

test("a different recipient gives a different key", () => {
  const other = provisioningKeyWith(SECRET, { ...input, recipientValue: "bob@example.com" });
  expect(other.publicKey).not.toBe(provisioningKeyWith(SECRET, input).publicKey);
});

test("a different business gives a different key", () => {
  const other = provisioningKeyWith(SECRET, { ...input, apiClientId: "client-2" });
  expect(other.publicKey).not.toBe(provisioningKeyWith(SECRET, input).publicKey);
});

test("a different salt gives a different key", () => {
  const other = provisioningKeyWith(SECRET, { ...input, salt: "fedcba9876543210" });
  expect(other.publicKey).not.toBe(provisioningKeyWith(SECRET, input).publicKey);
});

test("a different secret gives a different key", () => {
  const other = provisioningKeyWith("b".repeat(64), input);
  expect(other.publicKey).not.toBe(provisioningKeyWith(SECRET, input).publicKey);
});

test("the wallet address is the Media Wallet address of the public key", () => {
  const key = provisioningKeyWith(SECRET, input);
  expect(key.walletAddress).toBe(computeAccountAddress(key.publicKey, 0));
});

test("refuses a missing or short secret", () => {
  expect(() => provisioningKeyWith("", input)).toThrow("PROVISIONING_SECRET is not configured");
  expect(() => provisioningKeyWith("short", input)).toThrow("PROVISIONING_SECRET is not configured");
});
