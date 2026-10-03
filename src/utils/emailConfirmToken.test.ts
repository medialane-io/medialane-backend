import { test, expect } from "bun:test";
import { issueAccountSessionToken, verifyAccountSessionToken } from "@medialane/sdk";
import { issueConfirmToken, verifyConfirmToken } from "./emailConfirmToken";

const SECRET = "s".repeat(40);
const IN_A_DAY = new Date(Date.now() + 86_400_000);
const claims = { accountId: "acc_1", email: "alice@example.com", expiresAt: IN_A_DAY };

test("a fresh token gives back who it was issued for", () => {
  const out = verifyConfirmToken(SECRET, issueConfirmToken(SECRET, claims));
  expect(out?.accountId).toBe("acc_1");
  expect(out?.email).toBe("alice@example.com");
  expect(out?.expiresAt.getTime()).toBe(Math.floor(IN_A_DAY.getTime() / 1000) * 1000);
});

test("an expired token is refused", () => {
  const token = issueConfirmToken(SECRET, { ...claims, expiresAt: new Date(Date.now() - 1000) });
  expect(verifyConfirmToken(SECRET, token)).toBeNull();
});

test("a token signed with another secret is refused", () => {
  expect(verifyConfirmToken("o".repeat(40), issueConfirmToken(SECRET, claims))).toBeNull();
});

test("changing the payload breaks the signature", () => {
  const [, mac] = issueConfirmToken(SECRET, claims).split(".");
  const forged = Buffer.from(JSON.stringify({ p: "confirm-email", a: "acc_2", e: "bob@example.com", x: 9999999999 })).toString("base64url");
  expect(verifyConfirmToken(SECRET, `${forged}.${mac}`)).toBeNull();
});

test("junk is refused without throwing", () => {
  for (const junk of ["", "abc", "a.b", "a.b.c", ".", "..", "💥.💥"]) {
    expect(verifyConfirmToken(SECRET, junk)).toBeNull();
  }
});

test("a confirm token is never accepted as an account session, and the reverse", () => {
  expect(verifyAccountSessionToken(SECRET, issueConfirmToken(SECRET, claims))).toBeNull();
  expect(verifyConfirmToken(SECRET, issueAccountSessionToken(SECRET, "acc_1"))).toBeNull();
});
