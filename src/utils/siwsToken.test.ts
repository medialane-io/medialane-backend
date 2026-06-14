// Audit P2-3 — defense-in-depth around SIWS bearer tokens.
import { describe, expect, test } from "bun:test";

// Hoist env vars BEFORE importing the module — env validation runs at
// import time and rejects missing required vars (SIWS_SECRET, HMAC_KEY).
process.env.SIWS_SECRET ??= "test-secret-do-not-use-in-prod-0123456789";
process.env.HMAC_KEY ??= "test-hmac-key-do-not-use-in-prod-0123456789012345";

const { issueToken, verifyToken } = await import("./siwsToken.js");

describe("siwsToken — happy path", () => {
  test("roundtrips a wallet address", () => {
    const wallet = "0xdeadbeef";
    const token = issueToken("STARKNET", wallet);
    expect(token.startsWith("siws_")).toBe(true);
    expect(verifyToken(token)).toEqual({ address: wallet, chain: "STARKNET" });
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
    const token = issueToken("STARKNET", "0xabc");
    // Flip a char in the payload portion (between siws_ and .)
    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, 5) + "X" + token.slice(6, dot) + token.slice(dot);
    expect(verifyToken(tampered)).toBeNull();
  });

  test("rejects a token signed with the wrong key", () => {
    // We can't reach inside without changing env mid-test; instead, simulate
    // by mutating the signature half.
    const token = issueToken("STARKNET", "0xabc");
    const dot = token.lastIndexOf(".");
    const bogusSig = "0".repeat(64);
    expect(verifyToken(token.slice(0, dot + 1) + bogusSig)).toBeNull();
  });
});
