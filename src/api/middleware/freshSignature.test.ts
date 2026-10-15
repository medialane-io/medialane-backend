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

const WALLET = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const OTHER = "0x01575d29b83d7828cd1d833ef785083b809adeb187b6ac14aab21db568f2bf02";

async function keysApp() {
  const { Hono } = await import("hono");
  type Env = import("../../types/hono.js").AppEnv;
  const { createFreshSignature } = await import("./freshSignature.js");
  const { normalizeAddress } = await import("@medialane/sdk");
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-1", status: "ACTIVE" });
    return next();
  });
  app.use("*", createFreshSignature({
    ownsWallet: async (accountId, _chain, address) => accountId === "acct-1" && address === normalizeAddress("STARKNET", WALLET),
  }));
  app.post("/keys", (c) => c.json({ minted: true }));
  return (headers: Record<string, string> = {}) => app.request("/keys", { method: "POST", headers });
}

test("a recent signature by one of the account's wallets is accepted", async () => {
  const { issueToken } = await import("../../utils/siwsToken.js");
  const post = await keysApp();
  expect((await post({ "x-fresh-signature": issueToken("STARKNET", WALLET) })).status).toBe(200);
});

test("without a fresh signature the request is refused, however recent the session", async () => {
  const post = await keysApp();
  const res = await post();
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: "stale_signature" });
});

test("a signature by a wallet that is not the account's is refused", async () => {
  const { issueToken } = await import("../../utils/siwsToken.js");
  const post = await keysApp();
  expect((await post({ "x-fresh-signature": issueToken("STARKNET", OTHER) })).status).toBe(401);
});

test("an invalid signature token is refused", async () => {
  const post = await keysApp();
  expect((await post({ "x-fresh-signature": "siws_not.a.token" })).status).toBe(401);
});

test("a signature older than the limit is refused", async () => {
  const { setSystemTime } = await import("bun:test");
  const { issueToken } = await import("../../utils/siwsToken.js");
  const post = await keysApp();
  setSystemTime(new Date(Date.now() - (FRESH_SIGNATURE_SECONDS + 60) * 1000));
  const old = issueToken("STARKNET", WALLET);
  setSystemTime();
  expect((await post({ "x-fresh-signature": old })).status).toBe(401);
});
