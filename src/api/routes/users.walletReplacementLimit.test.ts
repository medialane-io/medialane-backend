import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

mock.module("../../db/client.js", () => ({
  default: {
    account: { findUnique: async () => ({ status: "ACTIVE" }) },
    identity: {
      findFirst: async () => ({ address: "0x0abc" }),
      findUnique: async () => ({ accountId: "acc_1" }),
    },
  },
}));

const realAccount = { ...(await import("../../utils/account.js")) };
mock.module("../../utils/account.js", () => ({
  ...realAccount,
  replaceWallet: async () => {
    throw new realAccount.WalletReplacementLimitError();
  },
}));

const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
const { issueToken } = await import("../../utils/siwsToken.js");
const users = (await import("./users.js")).default;

test("POST /users/me/generate-wallet over the daily replacements answers 429", async () => {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("appId", "MEDIALANE_IO");
    await next();
  });
  app.route("/users", users);
  const res = await app.request("/users/me/generate-wallet", {
    method: "POST",
    headers: { "content-type": "application/json", "x-account-session": issueAccountSessionToken("acc_1") },
    body: JSON.stringify({ newWalletSiwsToken: issueToken("STARKNET", "0x0def") }),
  });
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "Please try again tomorrow", code: "wallet_replacement_limit" });
});
