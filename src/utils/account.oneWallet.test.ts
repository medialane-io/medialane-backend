import { describe, expect, mock, test } from "bun:test";

const NEW_WALLET = "0x00000000000000000000000000000000000000000000000000000000000000aa";

function setup(accountHasWallet: boolean) {
  const create = mock(async (_arg?: unknown) => ({}));
  const deleteMany = mock(async (_arg?: unknown) => ({ count: 1 }));
  const calls: string[] = [];
  const transaction = mock(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        identity: {
          deleteMany: async (a: unknown) => { calls.push("delete"); return deleteMany(a); },
          create: async (a: unknown) => { calls.push("create"); return create(a); },
        },
      });
    }
    return undefined;
  });
  mock.module("../db/client.js", () => ({
    default: {
      identity: {
        findFirst: mock(async ({ where }: { where: { accountId?: string } }) =>
          accountHasWallet && where.accountId === "acct-1" ? { id: "w-old", address: "0xold" } : null),
        findUnique: mock(async () => null),
        create,
      },
      apiCredits: { upsert: mock(async () => ({})) },
      $transaction: transaction,
    },
  }));
  return { create, deleteMany, calls };
}

describe("linking a wallet to an account session", () => {
  test("is refused when the account already has a wallet", async () => {
    const { create } = setup(true);
    const { ensureAccountForWallet, WalletAlreadyAttachedError } = await import("./account.js");
    await expect(
      ensureAccountForWallet({ chain: "STARKNET", address: NEW_WALLET, appId: "c1", linkToAccountId: "acct-1" }),
    ).rejects.toBeInstanceOf(WalletAlreadyAttachedError);
    expect(create).not.toHaveBeenCalled();
  });

  test("still attaches the first wallet to an account that has none", async () => {
    const { create } = setup(false);
    const { ensureAccountForWallet } = await import("./account.js");
    const result = await ensureAccountForWallet({ chain: "STARKNET", address: NEW_WALLET, appId: "c1", linkToAccountId: "acct-1" });
    expect(result).toEqual({ accountId: "acct-1", created: false });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("replaceWallet", () => {
  test("removes the account's wallet and attaches the new one as its only wallet, in one transaction", async () => {
    const { create, deleteMany, calls } = setup(true);
    const { replaceWallet } = await import("./account.js");
    await replaceWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(calls).toEqual(["delete", "create"]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { accountId: "acct-1", scheme: "wallet" } });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ accountId: "acct-1", scheme: "wallet", chain: "STARKNET", address: NEW_WALLET, appId: "c1" });
  });
});
