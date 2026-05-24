// Audit P2-3 — defense-in-depth around SIWS bearer tokens.
import { describe, expect, test } from "bun:test";

// Hoist env var BEFORE importing the module — siwsToken.ts reads env at
// module load. Bun's test runner doesn't re-evaluate modules per file
// but `env` is read lazily inside the hmac() call, so set-and-import works.
process.env.SIWS_SECRET ??= "test-secret-do-not-use-in-prod-0123456789";

const { issueToken, verifyToken } = await import("./siwsToken.js");

describe("siwsToken — happy path", () => {
  test("roundtrips a wallet address", () => {
    const wallet = "0xdeadbeef";
    const token = issueToken(wallet);
    expect(token.startsWith("siws_")).toBe(true);
    expect(verifyToken(token)).toBe(wallet);
  });
});

describe("siwsToken — rejections", () => {
  test("rejects an obviously malformed token", () => {
    expect(verifyToken("not-a-siws-token")).toBeNull();
  });

  test("rejects a token with no dot separator", () => {
    expect(verifyToken("siws_onlyhalf")).toBeNull();
  });

  test("rejects a token with a tampered payload", () => {
    const token = issueToken("0xabc");
    // Flip a char in the payload portion (between siws_ and .)
    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, 5) + "X" + token.slice(6, dot) + token.slice(dot);
    expect(verifyToken(tampered)).toBeNull();
  });

  test("rejects a token signed with the wrong key", () => {
    // We can't reach inside without changing env mid-test; instead, simulate
    // by mutating the signature half.
    const token = issueToken("0xabc");
    const dot = token.lastIndexOf(".");
    const bogusSig = "0".repeat(64);
    expect(verifyToken(token.slice(0, dot + 1) + bogusSig)).toBeNull();
  });
});
