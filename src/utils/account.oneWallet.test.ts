import { describe, expect, mock, test } from "bun:test";

const NEW_WALLET = "0x00000000000000000000000000000000000000000000000000000000000000aa";

function setup(
  accountHasWallet: boolean,
  currentAddress = "0x00000000000000000000000000000000000000000000000000000000000000bb",
  knownWallet: { id: string; accountId: string } | null = null,
) {
  const create = mock(async (_arg?: unknown) => ({}));
  const update = mock(async (_arg?: unknown) => ({}));
  const calls: string[] = [];
  const transaction = mock(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        $queryRaw: async () => [],
        identity: {
          findFirst: async () => ({ id: "w-old", address: currentAddress }),
          findUnique: async () => knownWallet,
          update: async (a: { data: { status: string } }) => { calls.push(a.data.status === "INACTIVE" ? "retire" : "activate"); return update(a); },
          create: async (a: unknown) => { calls.push("create"); return create(a); },
        },
        accountEvent: { create: async () => { calls.push("event"); return {}; }, count: async () => 0 },
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
  return { create, update, calls };
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
  test("keeps the old wallet on the account as inactive, adds the new one as its active wallet and records the change, in one transaction", async () => {
    const { create, update, calls } = setup(true);
    const { replaceWallet } = await import("./account.js");
    await replaceWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(calls).toEqual(["retire", "create", "event"]);
    expect(update).toHaveBeenCalledWith({ where: { id: "w-old" }, data: { status: "INACTIVE" } });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ accountId: "acct-1", scheme: "wallet", chain: "STARKNET", address: NEW_WALLET, appId: "c1" });
  });
});

describe("replacing with one of the account's earlier wallets", () => {
  test("reactivates that wallet's row instead of adding a new one", async () => {
    const { create, update, calls } = setup(true, undefined, { id: "w-earlier", accountId: "acct-1" });
    const { replaceWallet } = await import("./account.js");
    await replaceWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET });
    expect(calls).toEqual(["retire", "activate", "event"]);
    expect(update).toHaveBeenLastCalledWith({ where: { id: "w-earlier" }, data: { status: "ACTIVE" } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("replacing with the account's current wallet", () => {
  test("same address is a no-op: nothing changed, nothing created, no history", async () => {
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
    expect(calls).toEqual(["retire", "create", "event"]);
  });

  test("refuses a different wallet when not asked to replace, and nothing changes", async () => {
    const { create, update, calls } = setup(true);
    const { attachDeployedWallet, WalletAlreadyAttachedError } = await import("./account.js");
    await expect(
      attachDeployedWallet({ accountId: "acct-1", appId: "c1", chain: "STARKNET", address: NEW_WALLET }),
    ).rejects.toBeInstanceOf(WalletAlreadyAttachedError);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
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
