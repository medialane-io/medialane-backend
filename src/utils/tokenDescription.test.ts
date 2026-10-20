import { describe, expect, test } from "bun:test";
import { ownDescription } from "./tokenDescription.js";

describe("a token keeps only a description of its own", () => {
  test("a description different from the collection's is kept", () => {
    expect(ownDescription("A red sword", "A collection of weapons")).toBe("A red sword");
  });

  test("a description identical to the collection's is not stored", () => {
    expect(ownDescription("A collection of weapons", "A collection of weapons")).toBeNull();
  });

  test("surrounding whitespace does not make a copy look different", () => {
    expect(ownDescription("  A collection of weapons\n", "A collection of weapons")).toBeNull();
  });

  test("a token description is kept when the collection has none", () => {
    expect(ownDescription("A red sword", null)).toBe("A red sword");
  });

  test("an empty or non-text description is not stored", () => {
    expect(ownDescription("", "x")).toBeNull();
    expect(ownDescription(42, "x")).toBeNull();
    expect(ownDescription(undefined, null)).toBeNull();
  });
});
