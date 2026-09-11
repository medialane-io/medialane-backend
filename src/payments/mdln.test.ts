import { describe, expect, test } from "bun:test";
import { multiplierForBalance } from "./mdln.js";

describe("multiplierForBalance", () => {
  test("holding nothing earns no discount", () => expect(multiplierForBalance(0n)).toBe(1.0));
  test("just under the first tier earns no discount", () =>
    expect(multiplierForBalance(99_999n)).toBe(1.0));
  test("100,000 earns 1.2x", () => expect(multiplierForBalance(100_000n)).toBe(1.2));
  test("just under the second tier holds at 1.2x", () =>
    expect(multiplierForBalance(199_999n)).toBe(1.2));
  test("200,000 earns 1.5x", () => expect(multiplierForBalance(200_000n)).toBe(1.5));
  test("500,000 earns 2.0x", () => expect(multiplierForBalance(500_000n)).toBe(2.0));
  test("holding more than the top tier stays at 2.0x", () =>
    expect(multiplierForBalance(21_000_000n)).toBe(2.0));
});
