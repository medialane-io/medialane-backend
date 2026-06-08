import { describe, it, expect } from "bun:test";
import { parseStandardFilter } from "./collections.standardFilter.js";

describe("parseStandardFilter", () => {
  it("returns null for empty/undefined (no filter)", () => {
    expect(parseStandardFilter(undefined)).toBeNull();
    expect(parseStandardFilter("")).toBeNull();
  });

  it("parses a single valid standard", () => {
    expect(parseStandardFilter("ERC20")).toEqual(["ERC20"]);
  });

  it("parses a CSV of valid standards, trimming + uppercasing", () => {
    expect(parseStandardFilter(" erc721 , erc1155 ")).toEqual(["ERC721", "ERC1155"]);
  });

  it("drops unknown tokens; returns null if nothing valid remains", () => {
    expect(parseStandardFilter("FOO,ERC20")).toEqual(["ERC20"]);
    expect(parseStandardFilter("FOO,BAR")).toBeNull();
  });

  it("dedupes", () => {
    expect(parseStandardFilter("ERC20,ERC20")).toEqual(["ERC20"]);
  });
});
