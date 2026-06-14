import { describe, it, expect } from "bun:test";
import { parseStandardFilter } from "./collections.standardFilter.js";

describe("parseStandardFilter", () => {
  it("returns null for empty/undefined (no filter)", () => {
    expect(parseStandardFilter(undefined)).toBeNull();
    expect(parseStandardFilter("")).toBeNull();
  });

  it("parses a single valid standard", () => {
    expect(parseStandardFilter("ERC721")).toEqual(["ERC721"]);
  });

  it("parses a CSV of valid standards, trimming + uppercasing", () => {
    expect(parseStandardFilter(" erc721 , erc1155 ")).toEqual(["ERC721", "ERC1155"]);
  });

  it("rejects ERC20 — Collection is NFT-only since the coin split", () => {
    expect(parseStandardFilter("ERC20")).toBeNull();
  });

  it("drops unknown tokens; returns null if nothing valid remains", () => {
    expect(parseStandardFilter("FOO,ERC721")).toEqual(["ERC721"]);
    expect(parseStandardFilter("FOO,BAR")).toBeNull();
  });

  it("dedupes", () => {
    expect(parseStandardFilter("ERC721,ERC721")).toEqual(["ERC721"]);
  });
});
