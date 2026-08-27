
import { describe, expect, test } from "bun:test";

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

    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, 5) + "X" + token.slice(6, dot) + token.slice(dot);
    expect(verifyToken(tampered)).toBeNull();
  });

  test("rejects a token signed with the wrong key", () => {

    const token = issueToken("STARKNET", "0xabc");
    const dot = token.lastIndexOf(".");
    const bogusSig = "0".repeat(64);
    expect(verifyToken(token.slice(0, dot + 1) + bogusSig)).toBeNull();
  });
});

// The two token families share a secret. Before domain separation the
// signature covered only the payload, so a token's *kind* was not signed —
// safe only for as long as their payload shapes happened to differ.
test("an account session token is not accepted as a SIWS identity token", async () => {
  const { issueAccountSessionToken } = await import("./accountSessionToken.js");
  const accountToken = issueAccountSessionToken("acc_TEST");
  const swapped = "siws_" + accountToken.slice("account_session_".length);
  expect(verifyToken(swapped)).toBeNull();
});

test("a SIWS token is not accepted as an account session token", async () => {
  const { verifyAccountSessionToken } = await import("./accountSessionToken.js");
  const siwsToken = issueToken("STARKNET", "0x1");
  const swapped = "account_session_" + siwsToken.slice("siws_".length);
  expect(verifyAccountSessionToken(swapped)).toBeNull();
});

test("a token signed without the domain tag still verifies during the transition", async () => {
  const { createHmac } = await import("crypto");
  const { env } = await import("../config/env.js");
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: "0x1", chain: "STARKNET", iat, exp: iat + 3600 }),
  ).toString("base64url");
  const legacySig = createHmac("sha256", env.SIWS_SECRET).update(payload).digest("hex");

  expect(verifyToken(`siws_${payload}.${legacySig}`)?.address).toBe("0x1");
});
