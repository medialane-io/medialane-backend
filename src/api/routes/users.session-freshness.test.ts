import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const VERIFIED_AT = new Date("2026-11-02T12:00:00Z");
let verifiedAt: Date | null = VERIFIED_AT;
let walletLookups = 0;

// Only the reads made before the session check are answered; anything after it fails the request loudly.
mock.module("../../db/client.js", () => ({
  default: {
    account: { findUnique: async () => ({ status: "ACTIVE" }) },
    identity: {
      findFirst: async () => {
        walletLookups++;
        return { address: "0x0abc" };
      },
    },
    accountEvent: { findFirst: async () => (verifiedAt ? { createdAt: verifiedAt } : null) },
  },
}));

const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
const users = (await import("./users.js")).default;

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("appId", "MEDIALANE_IO");
    await next();
  });
  a.route("/users", users);
  return a;
}

function sessionIssuedAt(date: Date): string {
  const realNow = Date.now;
  Date.now = () => date.getTime();
  try {
    return issueAccountSessionToken("acc_1");
  } finally {
    Date.now = realNow;
  }
}

const BEFORE = sessionIssuedAt(new Date(VERIFIED_AT.getTime() - 60_000));
const KEY = { newOwnerPubkey: "0x123" };

const ROUTES: Array<[string, unknown]> = [
  ["/users/me", { walletType: "mediawallet" }],
  ["/users/me/generate-wallet", { newWalletSiwsToken: "siws_x.y" }],
  ["/users/me/wallet/key", KEY],
  ["/users/me/wallet/recovery", KEY],
  ["/users/me/wallet/recovery/complete", KEY],
  ["/users/me/email", { email: "new@example.test" }],
];

beforeEach(() => {
  verifiedAt = VERIFIED_AT;
  walletLookups = 0;
});

describe("account changes with a session issued before verification", () => {
  for (const [path, body] of ROUTES) {
    test(`POST ${path} is refused with sign_in_again`, async () => {
      const res = await app().request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-account-session": BEFORE },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Sign in again to make this change", code: "sign_in_again" });
    });
  }
});
