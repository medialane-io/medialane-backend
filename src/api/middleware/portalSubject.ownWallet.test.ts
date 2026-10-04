import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { normalizeAddress } from "@medialane/sdk";
import type { AppEnv } from "../../types/hono.js";

const WALLET = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";
const ADDRESS = normalizeAddress("STARKNET", WALLET);

const keyAccount = {
  id: "acct-key",
  status: "ACTIVE",
  sessionsValidFrom: null,
  apiClient: { id: "client-key", accountId: "acct-key", plan: "FREE" as const, creditBalance: 99996 },
};

const createdAccount = {
  id: "acct-new",
  status: "ACTIVE",
  sessionsValidFrom: null,
  apiClient: { id: "client-new", accountId: "acct-new", plan: "FREE", creditBalance: 0 },
};

const strayAccount = {
  id: "acct-stray",
  status: "ACTIVE",
  sessionsValidFrom: null,
  apiClient: { id: "client-stray", accountId: "acct-stray", plan: "FREE", creditBalance: 0 },
};

async function signIn(options: { ownWallet: boolean; stray?: boolean }) {
  const ensure = mock(() => Promise.resolve({ accountId: "acct-new", created: true }));
  let ensured = false;
  const findUnique = mock(() =>
    Promise.resolve(options.stray ? { account: strayAccount } : ensured ? { account: createdAccount } : null),
  );
  const findFirst = mock(() => Promise.resolve(options.ownWallet ? { account: keyAccount } : null));
  mock.module("../../db/client.js", () => ({ default: { identity: { findUnique, findFirst } } }));
  mock.module("../../utils/account.js", () => ({
    ensureAccountForWallet: async (...args: unknown[]) => {
      ensured = true;
      return (ensure as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  }));
  const { portalSubject } = await import("./portalSubject.js");
  const { issueToken } = await import("../../utils/siwsToken.js");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key1",
      status: "ACTIVE" as const,
      apiClient: { ...keyAccount.apiClient, account: { id: "acct-key", status: "ACTIVE" as const } },
    });
    return next();
  });
  app.use("*", portalSubject);
  app.get("/me", (c) => c.json({ apiClient: c.get("apiClient").id, credits: c.get("apiClient").creditBalance }));
  const res = await app.request("/me", { headers: { Authorization: `Bearer ${issueToken("STARKNET", ADDRESS)}` } });
  return { res, ensure, findFirst };
}

describe("a key's own wallet", () => {
  test("signs in to the account that owns the key, without creating another account", async () => {
    const { res, ensure, findFirst } = await signIn({ ownWallet: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiClient: "client-key", credits: 99996 });
    expect(ensure).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ accountId: "acct-key", chain: "STARKNET", address: ADDRESS }) }),
    );
  });

  test("a wallet that is not the key's own still gets its own new account", async () => {
    const { res, ensure } = await signIn({ ownWallet: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiClient: "client-new", credits: 0 });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  test("wins over an empty account the same wallet already has under the key's client", async () => {
    const { res, ensure } = await signIn({ ownWallet: true, stray: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiClient: "client-key", credits: 99996 });
    expect(ensure).not.toHaveBeenCalled();
  });
});
