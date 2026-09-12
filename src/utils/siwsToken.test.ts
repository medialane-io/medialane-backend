import { test, expect } from "bun:test";
import { issueToken, tokenIssuedAt, verifyToken } from "./siwsToken.js";

const WALLET = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("a token reports when it was issued", () => {
  const before = Math.floor(Date.now() / 1000);
  const issued = tokenIssuedAt(issueToken("STARKNET", WALLET));
  expect(issued).not.toBeNull();
  expect(issued!).toBeGreaterThanOrEqual(before - 2);
  expect(issued!).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 2);
});

test("a token nobody signed reports nothing, so it cannot pass as fresh", () => {
  const forged = "siws_" + Buffer.from(JSON.stringify({ sub: WALLET, chain: "STARKNET", iat: 9999999999, exp: 9999999999 })).toString("base64url") + ".not-a-signature";
  expect(verifyToken(forged)).toBeNull();
  expect(tokenIssuedAt(forged)).toBeNull();
});

test("nonsense reports nothing rather than throwing", () => {
  expect(tokenIssuedAt("")).toBeNull();
  expect(tokenIssuedAt("siws_")).toBeNull();
  expect(tokenIssuedAt("not-a-token")).toBeNull();
});
