import { test, expect } from "bun:test";
import { FRESH_SIGNATURE_SECONDS, isFresh } from "./freshSignature.js";

const NOW = 1_700_000_000;

test("a signature made moments ago is fresh", () => {
  expect(isFresh(NOW, NOW)).toBe(true);
  expect(isFresh(NOW - 30, NOW)).toBe(true);
});

test("a signature is fresh right up to the limit and not past it", () => {
  expect(isFresh(NOW - FRESH_SIGNATURE_SECONDS, NOW)).toBe(true);
  expect(isFresh(NOW - FRESH_SIGNATURE_SECONDS - 1, NOW)).toBe(false);
});

test("a token stolen hours ago cannot mint anything", () => {
  expect(isFresh(NOW - 3600, NOW)).toBe(false);
  expect(isFresh(NOW - 23 * 3600, NOW)).toBe(false);
});

test("a timestamp from the future is not accepted as fresh", () => {
  expect(isFresh(NOW + 3600, NOW)).toBe(false);
});

test("small clock skew is tolerated", () => {
  expect(isFresh(NOW + 30, NOW)).toBe(true);
});
