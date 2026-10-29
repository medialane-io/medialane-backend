import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const NOW = () => Math.floor(Date.now() / 1000);

async function appWith(opts: { currentKeyId?: string | null; keyIdInTransaction?: string | null; ownedKeyId?: string; signatureValid?: boolean } = {}) {
  const current = opts.currentKeyId ?? null;
  const inTx = opts.keyIdInTransaction === undefined ? current : opts.keyIdInTransaction;
  const verified: unknown[] = [];
  const deleteMany = mock(async (_arg?: unknown) => ({ count: 1 }));
  const create = mock(async ({ data }: { data: { prefix: string; label?: string } }) => ({ id: "k-new", prefix: data.prefix, label: data.label ?? null }));
  const del = mock(async (_arg?: unknown) => ({}));
  const event = mock(async (_arg?: unknown) => ({}));
  const txFindFirst = mock(async ({ where }: { where: { id?: string } }) => {
    if (where.id) return where.id === opts.ownedKeyId ? { id: where.id, prefix: "ml_live_old1" } : null;
    return inTx ? { id: inTx, prefix: "ml_live_old1" } : null;
  });
  mock.module("../../db/client.js", () => ({
    default: {
      account: {
        findUnique: mock(async ({ select }: { select: Record<string, unknown> }) =>
          select.publicId ? { publicId: "acc_ABC" } : { id: "a1", status: "ACTIVE", apiCredits: { id: "ac1", accountId: "a1", creditBalance: 0 } }),
      },
      identity: { findFirst: mock(async () => ({ address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" })) },
      apiKey: { findMany: mock(async () => []), findFirst: mock(async () => (current ? { id: current } : null)) },
      $transaction: mock(async (run: (tx: unknown) => Promise<unknown>) =>
        run({ apiKey: { findFirst: txFindFirst, deleteMany, create, delete: del }, accountEvent: { create: event } })),
    },
  }));
  mock.module("../../auth/verify.js", () => ({
    verifyWalletSignature: async (input: unknown) => {
      verified.push(input);
      return opts.signatureValid === false ? { ok: false, reason: "invalid" } : { ok: true };
    },
  }));
  mock.module("../../utils/guardianCosign.js", () => ({
    productionCosign: async (_wallet: string, _typedData: unknown, signature: string[]) => signature,
    GuardianUnavailableError: class extends Error {},
  }));
  const { default: portal } = await import("./portal.js");
  const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
  const app = new Hono<AppEnv>();
  app.route("/", portal);
  const headers = { "Content-Type": "application/json", "x-account-session": issueAccountSessionToken("a1") };
  const confirmation = { expiresAt: NOW() + 120, signature: ["0x1", "0x2"] };
  return { app, headers, confirmation, verified, deleteMany, create, del, event };
}

const message = (v: unknown) => (v as { typedData: { message: Record<string, unknown> } }).typedData.message;

describe("an account has one API key, changed only with its wallet's confirmation", () => {
  test("replacing the key with a confirmation over the current key replaces it", async () => {
    const { app, headers, confirmation, verified, deleteMany, create } = await appWith({ currentKeyId: "k1" });
    const res = await app.request("/keys", { method: "POST", headers, body: JSON.stringify({ confirmation }) });
    expect(res.status).toBe(201);
    expect(message(verified[0])).toMatchObject({ action: "replace_api_key", key: "k1", account: "acc_ABC" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { apiCreditsId: "ac1" } });
    expect(create).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { data: { plaintext: string } };
    expect(body.data.plaintext.startsWith("ml_live_")).toBe(true);
  });

  test("the first key is confirmed over 'none'", async () => {
    const { app, headers, confirmation, verified } = await appWith({ currentKeyId: null });
    expect((await app.request("/keys", { method: "POST", headers, body: JSON.stringify({ confirmation }) })).status).toBe(201);
    expect(message(verified[0])).toMatchObject({ key: "none" });
  });

  test("without a confirmation, or with a bad signature, nothing changes", async () => {
    for (const setup of [{ body: {} }, { body: null, signatureValid: false }]) {
      const { app, headers, confirmation, create, del } = await appWith({ currentKeyId: "k1", ownedKeyId: "k1", signatureValid: setup.signatureValid });
      const body = JSON.stringify(setup.body ?? { confirmation });
      const created = await app.request("/keys", { method: "POST", headers, body });
      expect(created.status).toBe(403);
      expect(await created.json()).toMatchObject({ error: "confirmation_required" });
      expect((await app.request("/keys/k1", { method: "DELETE", headers, body })).status).toBe(403);
      expect(create).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    }
  });

  test("if the key changed after it was confirmed, the replacement is refused", async () => {
    const { app, headers, confirmation, create } = await appWith({ currentKeyId: "k1", keyIdInTransaction: "k2" });
    const res = await app.request("/keys", { method: "POST", headers, body: JSON.stringify({ confirmation }) });
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  test("deleting the key with a confirmation over that key removes it and records it", async () => {
    const { app, headers, confirmation, verified, del, event } = await appWith({ ownedKeyId: "k1" });
    const res = await app.request("/keys/k1", { method: "DELETE", headers, body: JSON.stringify({ confirmation }) });
    expect(res.status).toBe(200);
    expect(message(verified[0])).toMatchObject({ action: "delete_api_key", key: "k1" });
    expect(del).toHaveBeenCalledWith({ where: { id: "k1" } });
    expect(event).toHaveBeenCalledWith({ data: { accountId: "a1", type: "API_KEY_DELETED", data: { prefix: "ml_live_old1" } } });
  });

  test("deleting a key that is not the account's is a 404 and removes nothing", async () => {
    const { app, headers, confirmation, del } = await appWith({ ownedKeyId: "k1" });
    const res = await app.request("/keys/someone-elses", { method: "DELETE", headers, body: JSON.stringify({ confirmation }) });
    expect(res.status).toBe(404);
    expect(del).not.toHaveBeenCalled();
  });
});
