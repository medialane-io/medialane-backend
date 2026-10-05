import { describe, expect, mock, test } from "bun:test";

const WALLET = "0x00000000000000000000000000000000000000000000000000000000000000bb";

function setup(opts: { existing?: boolean; heldByAccount?: boolean }) {
  const upsert = mock(async (_arg?: unknown) => ({}));
  const txApiCreditsCreate = mock(async (_arg?: unknown) => ({}));
  mock.module("../db/client.js", () => ({
    default: {
      identity: {
        findFirst: mock(async () => null),
        findUnique: mock(async () => (opts.existing ? { id: "i1", accountId: "acct-1", provider: "x" } : null)),
        update: mock(async () => ({})),
        create: mock(async () => ({})),
      },
      apiCredits: { upsert },
      app: { findUnique: mock(async () => null) },
      $transaction: mock(async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          account: { create: async () => ({ id: "acct-new" }) },
          identity: { create: async () => ({}) },
          accountProfile: { create: async () => ({}) },
          apiCredits: { create: txApiCreditsCreate },
        }),
      ),
    },
  }));
  return { upsert, txApiCreditsCreate };
}

describe("an account created or found for a wallet", () => {
  test("a new account gets no ApiCredits", async () => {
    const { upsert, txApiCreditsCreate } = setup({});
    const { ensureAccountForWallet } = await import("./account.js");
    const result = await ensureAccountForWallet({ chain: "STARKNET", address: WALLET, clientId: "c1" });
    expect(result.created).toBe(true);
    expect(txApiCreditsCreate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  test("an existing account is returned without creating an ApiCredits", async () => {
    const { upsert } = setup({ existing: true });
    const { ensureAccountForWallet } = await import("./account.js");
    const result = await ensureAccountForWallet({ chain: "STARKNET", address: WALLET, clientId: "c1" });
    expect(result).toEqual({ accountId: "acct-1", created: false });
    expect(upsert).not.toHaveBeenCalled();
  });

  test("an account linked to a session gets no ApiCredits", async () => {
    const { upsert } = setup({});
    const { ensureAccountForWallet } = await import("./account.js");
    await ensureAccountForWallet({ chain: "STARKNET", address: WALLET, clientId: "c1", linkToAccountId: "acct-9" });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("ensureApiCredits", () => {
  test("creates the account's ApiCredits when it has none, or returns the one it has", async () => {
    const upsert = mock(async (_arg?: unknown) => ({ id: "ac1", accountId: "acct-1", plan: "FREE", creditBalance: 0 }));
    mock.module("../db/client.js", () => ({ default: { apiCredits: { upsert } } }));
    const { ensureApiCredits } = await import("./account.js");
    const client = await ensureApiCredits("acct-1");
    expect(client).toEqual({ id: "ac1", accountId: "acct-1", plan: "FREE", creditBalance: 0 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: "acct-1" }, create: { accountId: "acct-1" }, update: {} }));
  });
});
