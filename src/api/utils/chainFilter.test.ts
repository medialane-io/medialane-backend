import { describe, expect, test } from "bun:test";
import { parseChainFilter, parseSingleChain, chainWhere } from "./chainFilter.js";

describe("parseChainFilter", () => {
  test("defaults to STARKNET", () => {
    expect(parseChainFilter(undefined)).toEqual({ chain: "STARKNET" });
  });
  test("accepts chains case-insensitively", () => {
    expect(parseChainFilter("stellar")).toEqual({ chain: "STELLAR" });
    expect(parseChainFilter("BASE")).toEqual({ chain: "BASE" });
  });
  test("all passes through", () => {
    expect(parseChainFilter("all")).toBe("all");
    expect(chainWhere("all")).toEqual({});
  });
  test("invalid → null", () => {
    expect(parseChainFilter("dogecoin")).toBeNull();
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
    expect(parseSingleChain("stellar")).toBe("STELLAR");
  });
  test("'all' is rejected — keyed reads need one chain", () => {
    expect(parseSingleChain("all")).toBeNull();
  });
  test("invalid → null", () => {
    expect(parseSingleChain("dogecoin")).toBeNull();
  });
});
