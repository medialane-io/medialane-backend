import { describe, expect, mock, test } from "bun:test";

const WALLET = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";

async function ensure(options: { own: boolean; stray?: boolean }) {
  const findFirst = mock(() => Promise.resolve(options.own ? { accountId: "acct-key" } : null));
  const findUnique = mock(() => Promise.resolve(options.stray ? { id: "i1", accountId: "acct-stray", provider: "unknown" } : null));
  const transaction = mock(async (run: (tx: unknown) => Promise<string>) =>
    run({
      account: { create: async () => ({ id: "acct-new" }) },
      identity: { create: async () => ({}) },
      accountProfile: { create: async () => ({}) },
      apiClient: { create: async () => ({}) },
    }),
  );
  const upsert = mock(() => Promise.resolve({}));
  mock.module("../db/client.js", () => ({
    default: { identity: { findFirst, findUnique, update: mock(() => Promise.resolve({})) }, apiClient: { upsert }, $transaction: transaction },
  }));
  const { ensureAccountForWallet } = await import("./account.js");
  const result = await ensureAccountForWallet({ chain: "STARKNET", address: WALLET, clientId: "client-key" });
  return { result, transaction };
}

describe("a wallet the calling key's own account already holds", () => {
  test("is that account, and no other account is created", async () => {
    const { result, transaction } = await ensure({ own: true });
    expect(result).toEqual({ accountId: "acct-key", created: false });
    expect(transaction).not.toHaveBeenCalled();
  });

  test("is that account even when an empty one already exists for the same client", async () => {
    const { result } = await ensure({ own: true, stray: true });
    expect(result).toEqual({ accountId: "acct-key", created: false });
  });

  test("a wallet the key's account does not hold still gets its own new account", async () => {
    const { result, transaction } = await ensure({ own: false });
    expect(result).toEqual({ accountId: "acct-new", created: true });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
