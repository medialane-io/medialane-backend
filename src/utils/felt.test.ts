import { describe, expect, test } from "bun:test";
import { sameFelt } from "./felt.js";

describe("sameFelt", () => {
  test("the same value in hex and decimal is equal", () => {
    expect(sameFelt("0x10", "16")).toBe(true);
    expect(sameFelt("0x0010", "0x10")).toBe(true);
  });

  test("zero in any spelling is equal to zero", () => {
    expect(sameFelt("0x0", "0")).toBe(true);
  });

  test("different values are not equal", () => {
    expect(sameFelt("0x1", "0x2")).toBe(false);
  });

  test.each([[undefined], [null], [""], ["zz"], [{}]])("%p is never equal to anything", (bad) => {
    expect(sameFelt(bad, "0x0")).toBe(false);
    expect(sameFelt("0x0", bad)).toBe(false);
    expect(sameFelt(bad, bad)).toBe(false);
  });

  test("numbers and bigints are compared by value", () => {
    expect(sameFelt(16, "0x10")).toBe(true);
    expect(sameFelt(16n, "0x10")).toBe(true);
  });
});
