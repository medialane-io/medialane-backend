import { describe, expect, test } from "bun:test";
import { includeBalances } from "./collections.tokenBalances.js";

describe("collection token list balances", () => {
  test("ERC721 tokens carry their owner balance", () => {
    expect(includeBalances("ERC721")).toBe(true);
  });

  test("ERC1155 and unknown standards carry none", () => {
    expect(includeBalances("ERC1155")).toBe(false);
    expect(includeBalances(null)).toBe(false);
  });
});
