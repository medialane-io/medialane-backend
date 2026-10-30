import { describe, expect, mock, test } from "bun:test";

const NEW_WALLET = "0x00000000000000000000000000000000000000000000000000000000000000aa";

function setup(accountHasWallet: boolean, currentAddress = "0x00000000000000000000000000000000000000000000000000000000000000bb") {
  const create = mock(async (_arg?: unknown) => ({}));
  const deleteMany = mock(async (_arg?: unknown) => ({ count: 1 }));
  const calls: string[] = [];
  const transaction = mock(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        identity: {
          findFirst: async () => ({ address: currentAddress }),
          deleteMany: async (a: unknown) => { calls.push("delete"); return deleteMany(a); },
          create: async (a: unknown) => { calls.push("create"); return create(a); },
        },
        accountEvent: { create: async () => { calls.push("event"); return {}; } },
      });
    }
    return undefined;
  });
  mock.module("../db/client.js", () => ({
    default: {
      identity: {
        findFirst: mock(async ({ where }: { where: { accountId?: string } }) =>
          accountHasWallet && where.accountId === "acct-1" ? { id: "w-old", address: currentAddress } : null),
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
  test("removes the account's wallet, attaches the new one as its only wallet and records the change, in one transaction", async () => {
    const { create, deleteMany, calls } = setup(true);
    const { replaceWallet } = await import("./account.js");
    await replaceWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(calls).toEqual(["delete", "create", "event"]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { accountId: "acct-1", scheme: "wallet" } });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ accountId: "acct-1", scheme: "wallet", chain: "STARKNET", address: NEW_WALLET, appId: "c1" });
  });
});

describe("replacing with the account's current wallet", () => {
  test("same address is a no-op: nothing removed, nothing created, no history", async () => {
    const { calls } = setup(true, NEW_WALLET);
    const { replaceWallet } = await import("./account.js");
    await replaceWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(calls).toEqual([]);
  });
});

describe("attachDeployedWallet", () => {
  test("links the deployed wallet to an account that has none", async () => {
    const { create, calls } = setup(false);
    const { attachDeployedWallet } = await import("./account.js");
    await attachDeployedWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ accountId: "acct-1", scheme: "wallet", provider: "mediawallet", address: NEW_WALLET, appId: "c1" });
    expect(calls).toEqual([]);
  });

  test("replaces the account's wallet and records it when asked to replace", async () => {
    const { calls } = setup(true);
    const { attachDeployedWallet } = await import("./account.js");
    await attachDeployedWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET, replace: true });
    expect(calls).toEqual(["delete", "create", "event"]);
  });

  test("refuses a different wallet when not asked to replace, and nothing changes", async () => {
    const { create, deleteMany, calls } = setup(true);
    const { attachDeployedWallet, WalletAlreadyAttachedError } = await import("./account.js");
    await expect(
      attachDeployedWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET }),
    ).rejects.toBeInstanceOf(WalletAlreadyAttachedError);
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("changes nothing when the deployed wallet is already the account's wallet", async () => {
    const { create, calls } = setup(true, NEW_WALLET);
    const { attachDeployedWallet } = await import("./account.js");
    await attachDeployedWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(create).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
