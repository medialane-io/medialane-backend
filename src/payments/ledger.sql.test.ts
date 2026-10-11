import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("the credits ledger in shadow", () => {
  let prisma: PrismaClient;
  let credits: typeof import("./credits.js");
  let ledger: typeof import("./ledger.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    credits = await import("./credits.js");
    ledger = await import("./ledger.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let n = 0;
  async function wallet(balance: number) {
    n += 1;
    const account = await prisma.account.create({
      data: { publicId: `ledger-${n}-${Date.now()}`, apiCredits: { create: { creditBalance: balance } } },
      select: { id: true, apiCredits: { select: { id: true } } },
    });
    return { accountId: account.id, apiCreditsId: account.apiCredits!.id };
  }
  const balanceOf = async (id: string) =>
    (await prisma.apiCredits.findUniqueOrThrow({ where: { id }, select: { creditBalance: true } })).creditBalance;
  const entriesOf = (id: string) =>
    prisma.creditEntry.findMany({ where: { apiCreditsId: id }, orderBy: { createdAt: "asc" } });

  test("a spend lowers the balance and writes a USAGE entry together", async () => {
    const { apiCreditsId } = await wallet(100);
    expect(await ledger.spend(apiCreditsId, 30)).toBe(true);
    expect(await balanceOf(apiCreditsId)).toBe(70);
    expect((await entriesOf(apiCreditsId)).map((e) => [e.kind, e.credits])).toEqual([["USAGE", -30]]);
  });

  test("a spend above the balance changes nothing and writes nothing", async () => {
    const { apiCreditsId } = await wallet(10);
    expect(await ledger.spend(apiCreditsId, 30)).toBe(false);
    expect(await balanceOf(apiCreditsId)).toBe(10);
    expect(await entriesOf(apiCreditsId)).toHaveLength(0);
  });

  test("a refund raises the balance and writes a REFUND entry", async () => {
    const { apiCreditsId } = await wallet(0);
    await ledger.refund(apiCreditsId, 12);
    expect(await balanceOf(apiCreditsId)).toBe(12);
    expect((await entriesOf(apiCreditsId)).map((e) => [e.kind, e.credits])).toEqual([["REFUND", 12]]);
  });

  test("a payment writes the Payment and a PAYMENT entry linked to it", async () => {
    const { accountId, apiCreditsId } = await wallet(0);
    await credits.creditAccount({
      apiCreditsId,
      accountId,
      amountAtomic: 1_000_000n,
      creditedAmount: 100,
      mdlnMultiplier: 1,
      scheme: "starknet-transfer",
      network: "starknet",
      asset: "0xusdc",
      txHash: `0xpay${n}`,
      proofNonce: `0xpay${n}:0`,
    });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { proofNonce: `0xpay${n}:0` } });
    expect(await balanceOf(apiCreditsId)).toBe(100);
    expect((await entriesOf(apiCreditsId)).map((e) => [e.kind, e.credits, e.paymentId])).toEqual([["PAYMENT", 100, payment.id]]);
  });

  test("settling an unattributed payment writes its PAYMENT entry", async () => {
    const { accountId, apiCreditsId } = await wallet(0);
    const nonce = `0xun${n}:0`;
    const payment = await prisma.payment.create({
      data: { scheme: "s", network: "n", asset: "a", amountAtomic: "1", creditedAmount: 0, status: "UNATTRIBUTED", txHash: "0xun", proofNonce: nonce },
    });
    expect(
      await credits.settleUnattributedPayment({
        apiCreditsId, accountId, amountAtomic: 1n, creditedAmount: 40, mdlnMultiplier: 1,
        scheme: "s", network: "n", asset: "a", txHash: "0xun", proofNonce: nonce,
      }),
    ).toBe(true);
    expect(await balanceOf(apiCreditsId)).toBe(40);
    expect((await entriesOf(apiCreditsId)).map((e) => [e.kind, e.credits, e.paymentId])).toEqual([["PAYMENT", 40, payment.id]]);
  });

  test("a spend inside a transaction that fails leaves neither balance nor entry", async () => {
    const { apiCreditsId } = await wallet(50);
    await prisma
      .$transaction(async (tx) => {
        await ledger.spend(apiCreditsId, 20, tx);
        throw new Error("abort");
      })
      .catch(() => {});
    expect(await balanceOf(apiCreditsId)).toBe(50);
    expect(await entriesOf(apiCreditsId)).toHaveLength(0);
  });

  test("concurrent spends never go below zero and the entries add up to what was spent", async () => {
    const { apiCreditsId } = await wallet(50);
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.spend(apiCreditsId, 10)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await balanceOf(apiCreditsId)).toBe(0);
    const entries = await entriesOf(apiCreditsId);
    expect(entries.reduce((sum, e) => sum + e.credits, 0)).toBe(-50);
  });

  test("an entry can never be edited or deleted on its own", async () => {
    const { apiCreditsId } = await wallet(10);
    await ledger.spend(apiCreditsId, 5);
    const [entry] = await entriesOf(apiCreditsId);
    await expect((async () => prisma.creditEntry.update({ where: { id: entry!.id }, data: { credits: 1 } }))()).rejects.toThrow("append-only");
    await expect((async () => prisma.creditEntry.delete({ where: { id: entry!.id } }))()).rejects.toThrow("append-only");
  });

  test("removing a whole credits record removes its entries with it", async () => {
    const { accountId, apiCreditsId } = await wallet(10);
    await ledger.spend(apiCreditsId, 5);
    await prisma.account.delete({ where: { id: accountId } });
    expect(await prisma.creditEntry.count({ where: { apiCreditsId } })).toBe(0);
  });

  test("settling a request writes its usage record and the refund of the unused hold together", async () => {
    const { apiCreditsId } = await wallet(10);
    await ledger.spend(apiCreditsId, 5);
    await ledger.settleUsage(
      { apiCreditsId, actionKey: "read", chain: "STARKNET", service: "ALL", unitCredits: 5, units: 0, credits: 0, method: "GET", path: "/v1/x", status: 200 },
      5,
    );
    const usage = await prisma.usageEvent.findFirstOrThrow({ where: { apiCreditsId } });
    expect(await balanceOf(apiCreditsId)).toBe(10);
    expect((await entriesOf(apiCreditsId)).map((e) => [e.kind, e.credits, e.usageEventId])).toEqual([
      ["USAGE", -5, null],
      ["REFUND", 5, usage.id],
    ]);
  });

  test("a grant adds credits with its note", async () => {
    const { apiCreditsId } = await wallet(0);
    await ledger.grant(apiCreditsId, 250, "launch credits for the io app, by ops");
    expect(await balanceOf(apiCreditsId)).toBe(250);
    expect((await entriesOf(apiCreditsId)).map((e) => [e.kind, e.credits, e.note])).toEqual([["GRANT", 250, "launch credits for the io app, by ops"]]);
  });
});
