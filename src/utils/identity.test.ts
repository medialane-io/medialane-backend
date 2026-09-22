import { describe, expect, test } from "bun:test";
import { normalizeIdentityValue } from "./identity.js";

describe("normalizeIdentityValue", () => {
  test("lowercases and trims an email", () => {
    expect(normalizeIdentityValue("email", "  Ana@Example.COM ")).toBe("ana@example.com");
  });

  test("treats the same address written differently as one value", () => {
    expect(normalizeIdentityValue("email", "ANA@example.com"))
      .toBe(normalizeIdentityValue("email", "ana@EXAMPLE.com"));
  });

  test("does not lowercase a wallet address", () => {
    expect(normalizeIdentityValue("wallet", "0xAbC")).toBe("0xAbC");
  });
});
