import { beforeEach, expect, mock, test } from "bun:test";

type Row = { id: string; accountId: string; address: string; status: string; createdAt: Date };

let rows: Row[] = [];
let locked = 0;
let next = 0;

const tx = {
  $queryRaw: async () => { locked++; return []; },
  identity: {
    findFirst: async () => rows.find((r) => r.status === "ACTIVE") ?? null,
    findUnique: async ({ where }: { where: { appId_chain_address: { address: string } } }) =>
      rows.find((r) => r.address === where.appId_chain_address.address) ?? null,
    count: async ({ where }: { where: { accountId: string; createdAt: { gt: Date } } }) =>
      rows.filter((r) => r.accountId === where.accountId && r.createdAt > where.createdAt.gt).length,
    update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
      rows.find((r) => r.id === where.id)!.status = data.status;
    },
    create: async ({ data }: { data: { accountId: string; address: string } }) => {
      rows.push({ id: `r${next++}`, accountId: data.accountId, address: data.address, status: "ACTIVE", createdAt: new Date() });
    },
  },
};

mock.module("../db/client.js", () => ({
  default: { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
}));

const { replaceWallet, WalletReplacementLimitError } = await import("./account.js");
const { normalizeAddress } = await import("./starknet.js");
const n = (address: string) => normalizeAddress("STARKNET", address);
const DAY = 24 * 60 * 60 * 1000;

const replaceWith = (address: string) =>
  replaceWallet({ accountId: "acc_1", appId: "MEDIALANE_IO", chain: "STARKNET", address });
const activeAddress = () => rows.find((r) => r.status === "ACTIVE")?.address;

beforeEach(() => {
  rows = [{ id: "r0", accountId: "acc_1", address: n("0x0aaa"), status: "ACTIVE", createdAt: new Date(Date.now() - 30 * DAY) }];
  locked = 0;
  next = 1;
});

test("a fourth new wallet within 24 hours is refused and the wallet stays", async () => {
  await replaceWith("0x0b01");
  await replaceWith("0x0b02");
  await replaceWith("0x0b03");
  await expect(replaceWith("0x0b04")).rejects.toBeInstanceOf(WalletReplacementLimitError);
  expect(activeAddress()).toBe(n("0x0b03"));
});

test("a new wallet is accepted once the earlier ones are more than 24 hours old", async () => {
  const old = new Date(Date.now() - DAY - 1000);
  rows.push(...[1, 2, 3].map((i) => ({ id: `o${i}`, accountId: "acc_1", address: n(`0x0c0${i}`), status: "INACTIVE", createdAt: old })));
  await replaceWith("0x0b04");
  expect(activeAddress()).toBe(n("0x0b04"));
});

test("going back to a wallet the account already had is not limited", async () => {
  await replaceWith("0x0b01");
  await replaceWith("0x0b02");
  await replaceWith("0x0b03");
  await replaceWith("0x0aaa");
  expect(activeAddress()).toBe(n("0x0aaa"));
});

test("re-linking the current wallet changes nothing", async () => {
  await replaceWith("0x0aaa");
  expect(rows).toHaveLength(1);
});

test("replacements for one account are serialised", async () => {
  await replaceWith("0x0b01");
  expect(locked).toBe(1);
});
