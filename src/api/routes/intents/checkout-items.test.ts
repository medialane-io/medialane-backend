import { test, expect } from "bun:test";
import { checkoutBodySchema, normalizeCheckoutItems } from "./_shared.js";

test("accepts the legacy orderHashes array", () => {
  const parsed = checkoutBodySchema.safeParse({ fulfiller: "0x1", orderHashes: ["0xa", "0xb"] });
  expect(parsed.success).toBe(true);
});

test("accepts items carrying a per-order quantity", () => {
  const parsed = checkoutBodySchema.safeParse({
    fulfiller: "0x1",
    items: [{ orderHash: "0xa", quantity: "3" }],
  });
  expect(parsed.success).toBe(true);
});

test("rejects a body carrying neither form", () => {
  expect(checkoutBodySchema.safeParse({ fulfiller: "0x1" }).success).toBe(false);
});

test("rejects an empty list either way", () => {
  expect(checkoutBodySchema.safeParse({ fulfiller: "0x1", orderHashes: [] }).success).toBe(false);
  expect(checkoutBodySchema.safeParse({ fulfiller: "0x1", items: [] }).success).toBe(false);
});

test("legacy hashes normalize to items with no quantity", () => {
  expect(normalizeCheckoutItems({ orderHashes: ["0xa", "0xb"] })).toEqual([
    { orderHash: "0xa", quantity: undefined },
    { orderHash: "0xb", quantity: undefined },
  ]);
});

test("items keep their quantity through normalization", () => {
  expect(normalizeCheckoutItems({ items: [{ orderHash: "0xa", quantity: "3" }] })).toEqual([
    { orderHash: "0xa", quantity: "3" },
  ]);
});

test("items win when a caller sends both", () => {
  const out = normalizeCheckoutItems({
    orderHashes: ["0xz"],
    items: [{ orderHash: "0xa", quantity: "2" }],
  });
  expect(out).toEqual([{ orderHash: "0xa", quantity: "2" }]);
});

test("a quantity of zero or a non-numeric string is rejected", () => {
  expect(checkoutBodySchema.safeParse({ fulfiller: "0x1", items: [{ orderHash: "0xa", quantity: "0" }] }).success).toBe(false);
  expect(checkoutBodySchema.safeParse({ fulfiller: "0x1", items: [{ orderHash: "0xa", quantity: "x" }] }).success).toBe(false);
});
