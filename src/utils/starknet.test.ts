// Golden tests for the address/hash normalizers re-exported from @medialane/sdk.
// Reason these matter: "lowercase alone" was a known bug class — it doesn't pad
// short Starknet addresses, causing "not found" mismatches between DB writes
// and DB reads. Audit P1-10 + R0.
import { describe, expect, test } from "bun:test";
import { normalizeAddress, normalizeHash } from "./starknet.js";

describe("normalizeAddress", () => {
  test("pads a short address to 64 chars", () => {
    expect(normalizeAddress("STARKNET", "0x1")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  test("accepts and normalizes a fully-padded address", () => {
    const padded =
      "0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2";
    expect(normalizeAddress("STARKNET", padded)).toBe(padded);
  });

  test("lowercases uppercase hex", () => {
    expect(normalizeAddress("STARKNET", "0xABCD")).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000abcd",
    );
  });

  test("idempotent on already-normalized input", () => {
    const addr = normalizeAddress("STARKNET", "0xdead");
    expect(normalizeAddress("STARKNET", addr)).toBe(addr);
  });

  test("accepts decimal-string input (BigInt path)", () => {
    expect(normalizeAddress("STARKNET", "1")).toBe(normalizeAddress("STARKNET", "0x1"));
  });

  test("throws on non-hex input — guards against silent corruption", () => {
    expect(() => normalizeAddress("STARKNET", "banana")).toThrow("Invalid STARKNET address");
  });

  // Note: empty string is normalized to the zero address (BigInt("") === 0n).
  // Not asserted either way — behavior is stable but neither obviously right
  // nor obviously wrong; locking it in via test would constrain a future fix.
});

describe("normalizeHash", () => {
  test("pads and lowercases like normalizeAddress", () => {
    expect(normalizeHash("0xABCD")).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000abcd",
    );
  });

  test("throws on invalid hash", () => {
    expect(() => normalizeHash("not-a-hash")).toThrow("Invalid hash");
  });
});
