import { describe, expect, test } from "bun:test";
// env preloaded via bunfig.toml → importing mdln.js (which loads utils/starknet
// → env) is safe without mocks. We test only the pure tier function.
import { multiplierForBalance } from "./mdln.js";

describe("multiplierForBalance", () => {
  test("< 500 MDLN → 1.0x", () => expect(multiplierForBalance(0n)).toBe(1.0));
  test("500 → 1.2x", () => expect(multiplierForBalance(500n)).toBe(1.2));
  test("1999 → 1.2x", () => expect(multiplierForBalance(1999n)).toBe(1.2));
  test("2000 → 1.5x", () => expect(multiplierForBalance(2000n)).toBe(1.5));
  test("5000 → 2.0x", () => expect(multiplierForBalance(5000n)).toBe(2.0));
  test("10000 → 2.0x", () => expect(multiplierForBalance(10000n)).toBe(2.0));
});
