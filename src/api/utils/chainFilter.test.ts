import { describe, expect, test } from "bun:test";
import { parseChainFilter, parseSingleChain, chainWhere } from "./chainFilter.js";

describe("parseChainFilter", () => {
  test("defaults to STARKNET", () => {
    expect(parseChainFilter(undefined)).toEqual({ chain: "STARKNET" });
  });
  test("accepts the chain case-insensitively", () => {
    expect(parseChainFilter("starknet")).toEqual({ chain: "STARKNET" });
    expect(parseChainFilter("STARKNET")).toEqual({ chain: "STARKNET" });
  });

  test("a chain the backend does not index is refused at the edge", () => {
    for (const other of ["ethereum", "BASE", "solana", "stellar"]) {
      expect(parseChainFilter(other)).toBeNull();
    }
  });
  test("all passes through", () => {
    expect(parseChainFilter("all")).toBe("all");
    expect(chainWhere("all")).toEqual({});
  });
  test("invalid → null", () => {
    expect(parseChainFilter("dogecoin")).toBeNull();
  });
  test("BITCOIN is rejected until rows can exist (normalizeAddress throws for it)", () => {
    expect(parseChainFilter("bitcoin")).toBeNull();
    expect(parseSingleChain("bitcoin")).toBeNull();
  });
  test("chainWhere builds the clause", () => {
    expect(chainWhere({ chain: "STARKNET" as any })).toEqual({ chain: "STARKNET" });
  });
});

describe("parseSingleChain", () => {
  test("defaults to STARKNET", () => {
    expect(parseSingleChain(undefined)).toBe("STARKNET");
  });
  test("accepts a chain case-insensitively", () => {
    expect(parseSingleChain("starknet")).toBe("STARKNET");
  });
  test("'all' is rejected — keyed reads need one chain", () => {
    expect(parseSingleChain("all")).toBeNull();
  });
  test("invalid → null", () => {
    expect(parseSingleChain("dogecoin")).toBeNull();
  });
});
