import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

mock.module("../../db/client.js", () => ({
  default: {
    account: { findUnique: async () => ({ status: "ACTIVE", sessionsValidFrom: null }) },
  },
}));

let proofResult: { ok: true } | { ok: false; status: 400 | 401; body: { error: string } } = { ok: true };
const proofs: unknown[] = [];
const realProof = { ...(await import("../../auth/siwsProof.js")) };
mock.module("../../auth/siwsProof.js", () => ({
  ...realProof,
  consumeSiwsProof: async (params: unknown) => {
    proofs.push(params);
    return proofResult;
  },
}));

const replaced: unknown[] = [];
const realAccount = { ...(await import("../../utils/account.js")) };
mock.module("../../utils/account.js", () => ({
  ...realAccount,
  replaceWallet: async (params: unknown) => {
    replaced.push(params);
  },
}));

const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
const users = (await import("./users.js")).default;

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("appId", "MEDIALANE_IO");
  await next();
});
app.route("/users", users);

const body = { walletAddress: "0x0def", nonce: "n1", signature: ["0x1", "0x2"] };
const recover = (session: string | null) =>
  app.request("/users/me/wallet/recover-with-key", {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { "x-account-session": session } : {}) },
    body: JSON.stringify(body),
  });

const reset = () => {
  proofs.length = 0;
  replaced.length = 0;
  proofResult = { ok: true };
};

test("a proven wallet becomes the account's wallet, outside the new wallet limit", async () => {
  reset();
  const res = await recover(issueAccountSessionToken("acc_1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ walletAddress: expect.stringMatching(/^0x0*def$/) });
  expect(proofs).toEqual([{ chain: "STARKNET", wallet: expect.stringMatching(/^0x0*def$/), nonce: "n1", signature: ["0x1", "0x2"] }]);
  expect(replaced).toEqual([
    { accountId: "acc_1", appId: "MEDIALANE_IO", chain: "STARKNET", address: expect.stringMatching(/^0x0*def$/), limited: false },
  ]);
});

test("a signature that does not prove the wallet changes nothing", async () => {
  reset();
  proofResult = { ok: false, status: 401, body: { error: "invalid_signature" } };
  const res = await recover(issueAccountSessionToken("acc_1"));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "invalid_signature" });
  expect(replaced).toEqual([]);
});

test("without a session nothing is checked or changed", async () => {
  reset();
  const res = await recover(null);
  expect(res.status).toBe(401);
  expect(proofs).toEqual([]);
  expect(replaced).toEqual([]);
});
