import { beforeEach, expect, mock, test } from "bun:test";

type Nonce = { nonce: string; walletAddress: string; expiresAt: Date };
let nonces: Nonce[] = [];
let verdict: { ok: true } | { ok: false; reason: string } = { ok: true };

mock.module("../db/client.js", () => ({
  default: {
    siwsNonce: {
      findUnique: async ({ where }: { where: { nonce: string } }) => nonces.find((n) => n.nonce === where.nonce) ?? null,
      delete: async ({ where }: { where: { nonce: string } }) => {
        nonces = nonces.filter((n) => n.nonce !== where.nonce);
      },
      deleteMany: async ({ where }: { where: { nonce: string } }) => {
        const before = nonces.length;
        nonces = nonces.filter((n) => n.nonce !== where.nonce);
        return { count: before - nonces.length };
      },
    },
  },
}));

const { consumeSiwsProof } = await import("./siwsProof.js");

const WALLET = "0x0def";
const proof = (nonce = "n1", wallet = WALLET) =>
  consumeSiwsProof({ chain: "STARKNET", wallet, nonce, signature: ["0x1", "0x2"] }, async () => verdict as never);

beforeEach(() => {
  nonces = [{ nonce: "n1", walletAddress: WALLET, expiresAt: new Date(Date.now() + 60_000) }];
  verdict = { ok: true };
});

test("a valid signature is accepted once and the nonce is spent", async () => {
  expect(await proof()).toEqual({ ok: true });
  expect(await proof()).toEqual({ ok: false, status: 400, body: { error: "nonce_expired" } });
});

test("an expired nonce is refused and removed", async () => {
  nonces[0]!.expiresAt = new Date(Date.now() - 1000);
  expect(await proof()).toEqual({ ok: false, status: 400, body: { error: "nonce_expired" } });
  expect(nonces).toEqual([]);
});

test("a nonce issued for another wallet is refused", async () => {
  expect(await proof("n1", "0x0abc")).toEqual({ ok: false, status: 400, body: { error: "wallet_mismatch" } });
});

test("a signature the wallet does not accept is refused and the nonce stays", async () => {
  verdict = { ok: false, reason: "invalid" };
  expect(await proof()).toEqual({ ok: false, status: 401, body: { error: "invalid_signature" } });
  expect(nonces).toHaveLength(1);
});

test("a wallet that is not deployed says so", async () => {
  verdict = { ok: false, reason: "not_deployed" };
  const result = await proof();
  expect(result).toMatchObject({ ok: false, status: 400, body: { error: "account_not_deployed" } });
});
