import { describe, expect, test } from "bun:test";
import { composeAmountDisplay } from "./serialize.js";

describe("composeAmountDisplay", () => {
  test("joins value and currency into the API display shape", () => {
    expect(composeAmountDisplay("1.500000", "USDC")).toBe("1.500000 USDC");
    expect(composeAmountDisplay("0.010000000000000000", "ETH")).toBe("0.010000000000000000 ETH");
  });

  test("null/empty value → null (no floor / no volume)", () => {
    expect(composeAmountDisplay(null, "USDC")).toBeNull();
    expect(composeAmountDisplay(undefined, null)).toBeNull();
    expect(composeAmountDisplay("", "USDC")).toBeNull();
  });

  test("value without currency passes through (pre-split legacy rows)", () => {
    expect(composeAmountDisplay("1.500000", null)).toBe("1.500000");
    expect(composeAmountDisplay("1.500000", undefined)).toBe("1.500000");
  });
});
