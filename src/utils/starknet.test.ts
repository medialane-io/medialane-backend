

import { describe, expect, test } from "bun:test";
import { normalizeAddress, normalizeHash, callRpc } from "./starknet.js";

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

describe("callRpc", () => {
  test("retries once on the fallback path after a failure, and returns its result", async () => {
    let calls = 0;
    const result = await callRpc(async () => {
      calls++;
      if (calls === 1) throw new Error("transient primary RPC failure");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("propagates the error when both the initial call and its retry fail", async () => {
    let calls = 0;
    await expect(
      callRpc(async () => {
        calls++;
        throw new Error("genuinely unreachable");
      }),
    ).rejects.toThrow("genuinely unreachable");
    expect(calls).toBe(2);
  });
});
