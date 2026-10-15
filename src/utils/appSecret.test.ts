import { expect, test } from "bun:test";
import { appSecretMatches, generateAppSecret, hashAppSecret } from "./appSecret.js";

test("a generated secret is 32 random bytes in base64url and hashes to 64 hex chars", () => {
  const s = generateAppSecret();
  expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(generateAppSecret()).not.toBe(s);
  expect(hashAppSecret(s)).toMatch(/^[0-9a-f]{64}$/);
});

test("matches any stored hash, and nothing when the secret is missing or wrong", () => {
  const a = generateAppSecret(), b = generateAppSecret();
  const hashes = [hashAppSecret(a), hashAppSecret(b)];
  expect(appSecretMatches(a, hashes)).toBe(true);
  expect(appSecretMatches(b, hashes)).toBe(true);
  expect(appSecretMatches("wrong", hashes)).toBe(false);
  expect(appSecretMatches(undefined, hashes)).toBe(false);
  expect(appSecretMatches(a, [])).toBe(false);
});
