import { describe, expect, test } from "bun:test";
import { parseChainFilter, parseSingleChain, chainWhere, normalizedForms, addressWhere } from "./chainFilter.js";

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

describe("enabled chains", () => {
  test("a chain in the enabled list is accepted", () => {
    expect(parseSingleChain("base", ["STARKNET", "BASE"])).toBe("BASE");
    expect(parseChainFilter("BASE", ["STARKNET", "BASE"])).toEqual({ chain: "BASE" });
  });
  test("the real list serves only STARKNET", () => {
    expect(parseSingleChain("base")).toBeNull();
  });
});

describe("normalizedForms", () => {
  const EVM = `0x${"ab".repeat(20)}`;
  const STARK = `0x${"0".repeat(61)}abc`;
  const STARK_FORM_OF_EVM = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
  const EVM_FORM = "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB";
  const both = ["STARKNET", "BASE"] as const;

  test("an explicit chain gives that chain's form", () => {
    expect(normalizedForms({ chain: "STARKNET" }, EVM)).toEqual([STARK_FORM_OF_EVM]);
    expect(normalizedForms({ chain: "BASE" }, EVM)).toEqual([EVM_FORM]);
  });

  test("an explicit chain that rejects the address throws, as normalizeAddress does", () => {
    expect(() => normalizedForms({ chain: "BASE" }, STARK)).toThrow();
  });

  test("all gives the form of every enabled chain that accepts the address", () => {
    expect(normalizedForms("all", EVM, both).sort()).toEqual([EVM_FORM, STARK_FORM_OF_EVM].sort());
    expect(normalizedForms("all", STARK, both)).toEqual([STARK]);
  });

  test("all with one enabled chain gives one form", () => {
    expect(normalizedForms("all", EVM, ["STARKNET"])).toEqual([STARK_FORM_OF_EVM]);
  });

  test("all with an address no enabled chain accepts gives none", () => {
    expect(normalizedForms("all", "nope", both)).toEqual([]);
  });
});

describe("addressWhere", () => {
  const EVM = `0x${"ab".repeat(20)}`;

  test("one form is a plain value", () => {
    expect(addressWhere({ chain: "STARKNET" }, EVM)).toBe(`0x${"0".repeat(24)}${"ab".repeat(20)}`);
    expect(addressWhere("all", EVM, ["STARKNET"])).toBe(`0x${"0".repeat(24)}${"ab".repeat(20)}`);
  });

  test("several forms match any of them", () => {
    const where = addressWhere("all", EVM, ["STARKNET", "BASE"]);
    expect(where).toEqual({ in: expect.arrayContaining([expect.any(String), expect.any(String)]) });
  });

  test("no form matches nothing", () => {
    expect(addressWhere("all", "nope", ["STARKNET", "BASE"])).toEqual({ in: [] });
  });
});
