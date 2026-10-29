import { describe, expect, test } from "bun:test";
import { guardianConfigured } from "./guardianKey.js";

describe("guardianConfigured", () => {
  test("an empty secret is not configured", () => {
    expect(guardianConfigured("")).toBe(false);
  });

  test("a secret shorter than 32 characters is not configured", () => {
    expect(guardianConfigured("x".repeat(31))).toBe(false);
  });

  test("a secret of 32 characters is configured", () => {
    expect(guardianConfigured("x".repeat(32))).toBe(true);
  });
});
