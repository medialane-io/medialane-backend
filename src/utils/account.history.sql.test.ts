import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("identity changes", () => {
  let prisma: PrismaClient;
  let account: typeof import("./account.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    account = await import("./account.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let n = 0;
  const newAccount = async (identities: { scheme: string; value?: string; chain?: "STARKNET"; address?: string }[]) => {
    n += 1;
    const created = await prisma.account.create({
      data: {
        publicId: `history-${n}-${Date.now()}`,
        identities: { create: identities.map((i) => ({ ...i, appId: "MEDIALANE_API" })) },
      },
      select: { id: true },
    });
    return created.id;
  };
  const RUN = Date.now();
  let w = 0;
  /** A normalized Starknet address no earlier run has used. */
  const freshWallet = () => {
    w += 1;
    return `0x${(BigInt(RUN) * 1000n + BigInt(w)).toString(16).padStart(64, "0")}`;
  };

  test("a replaced wallet stays on its account as INACTIVE, signs nothing in and is never deleted", async () => {
    const old = freshWallet();
    const next = freshWallet();
    const accountId = await newAccount([{ scheme: "wallet", chain: "STARKNET", address: old }]);
    await account.replaceWallet({ accountId, appId: "MEDIALANE_API", chain: "STARKNET", address: next });

    const wallets = await prisma.identity.findMany({ where: { accountId, scheme: "wallet" }, orderBy: { createdAt: "asc" }, select: { address: true, status: true } });
    expect(wallets).toEqual([{ address: old, status: "INACTIVE" }, { address: next, status: "ACTIVE" }]);
    expect(await account.accountWallet(accountId)).toBe(next);
    expect(await account.resolveAccountIdFromWallet("MEDIALANE_API", "STARKNET", old)).toBeNull();
    await expect(account.ensureAccountForWallet({ chain: "STARKNET", address: old, appId: "MEDIALANE_API" })).rejects.toBeInstanceOf(account.WalletInactiveError);
    await expect((async () => prisma.identity.deleteMany({ where: { accountId } }))()).rejects.toThrow("never deleted");
    expect(await prisma.identity.count({ where: { accountId } })).toBe(2);
  });

  test("making an earlier wallet active again reactivates its row", async () => {
    const old = freshWallet();
    const next = freshWallet();
    const accountId = await newAccount([{ scheme: "wallet", chain: "STARKNET", address: old }]);
    await account.replaceWallet({ accountId, appId: "MEDIALANE_API", chain: "STARKNET", address: next });
    await account.replaceWallet({ accountId, appId: "MEDIALANE_API", chain: "STARKNET", address: old });

    const wallets = await prisma.identity.findMany({ where: { accountId, scheme: "wallet" }, orderBy: { createdAt: "asc" }, select: { address: true, status: true } });
    expect(wallets).toEqual([{ address: old, status: "ACTIVE" }, { address: next, status: "INACTIVE" }]);
  });

  test("a changed email stays on its account as INACTIVE and no longer finds the account", async () => {
    const oldEmail = `kept-${n}-${RUN}@x.com`;
    const accountId = await newAccount([{ scheme: "email", value: oldEmail }]);
    await account.replaceEmail({ accountId, appId: "MEDIALANE_API", email: `now-${n}-${RUN}@y.com` });

    const emails = await prisma.identity.findMany({ where: { accountId, scheme: "email" }, orderBy: { createdAt: "asc" }, select: { value: true, status: true } });
    expect(emails).toEqual([{ value: oldEmail, status: "INACTIVE" }, { value: `now-${n}-${RUN}@y.com`, status: "ACTIVE" }]);
    expect(await account.findLiveAccountIdByEmail(oldEmail, "MEDIALANE_API")).toBeNull();
    expect(await account.findLiveAccountIdByEmail(`now-${n}-${RUN}@y.com`, "MEDIALANE_API")).toBe(accountId);
  });
});
