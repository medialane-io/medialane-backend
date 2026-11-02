import { beforeEach, expect, mock, test } from "bun:test";

let events: Array<{ type: string; createdAt: Date }> = [];
let wallet = "";
let locked = 0;

// A fake transaction over one account: its wallet identity and its account events.
const tx = {
  $queryRaw: async () => { locked++; return []; },
  identity: {
    findFirst: async () => ({ address: wallet }),
    deleteMany: async () => ({ count: 1 }),
    create: async ({ data }: { data: { address: string } }) => { wallet = data.address; },
  },
  accountEvent: {
    count: async ({ where }: { where: { type: string; createdAt: { gt: Date } } }) =>
      events.filter((e) => e.type === where.type && e.createdAt > where.createdAt.gt).length,
    create: async ({ data }: { data: { type: string } }) => { events.push({ type: data.type, createdAt: new Date() }); },
  },
};

mock.module("../db/client.js", () => ({
  default: { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
}));

const { replaceWallet, WalletReplacementLimitError } = await import("./account.js");
const { normalizeAddress } = await import("./starknet.js");
const n = (address: string) => normalizeAddress("STARKNET", address);

const replaceWith = (address: string) =>
  replaceWallet({ accountId: "acc_1", appId: "MEDIALANE_IO", chain: "STARKNET", address });

beforeEach(() => {
  events = [];
  wallet = n("0x0aaa");
  locked = 0;
});

test("the fourth replacement within 24 hours is refused and the wallet stays", async () => {
  await replaceWith("0x0b01");
  await replaceWith("0x0b02");
  await replaceWith("0x0b03");
  await expect(replaceWith("0x0b04")).rejects.toBeInstanceOf(WalletReplacementLimitError);
  expect(wallet).toBe(n("0x0b03"));
});

test("a replacement is accepted once the earlier ones are more than 24 hours old", async () => {
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000);
  events = [1, 2, 3].map(() => ({ type: "WALLET_REPLACED", createdAt: old }));
  await replaceWith("0x0b04");
  expect(wallet).toBe(n("0x0b04"));
});

test("re-linking the same wallet is not a replacement", async () => {
  events = [1, 2, 3].map(() => ({ type: "WALLET_REPLACED", createdAt: new Date() }));
  await replaceWith("0x0aaa");
  expect(events).toHaveLength(3);
});

test("replacements for one account are serialised", async () => {
  await replaceWith("0x0b01");
  expect(locked).toBe(1);
});
