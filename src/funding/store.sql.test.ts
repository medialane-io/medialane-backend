import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import type { FundingStore, VerifiedPayment } from "./types.js";

const databaseUrl = process.env.FUNDING_STORE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("the funding store against Postgres", () => {
  let prisma: PrismaClient;
  let store: FundingStore;
  let accountId: string;
  let apiClientId: string;

  const verified = (nonce: string): VerifiedPayment => ({
    valueUsdcAtomic: 1_000_000n,
    asset: "0xusdc",
    payer: "0xpayer",
    proofNonce: nonce,
    scheme: "starknet-transfer",
    network: "starknet",
    txHash: nonce,
  });

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    store = (await import("./store.js")).prismaFundingStore;
    const account = await prisma.account.create({
      data: { publicId: `funding-${Date.now()}`, apiClient: { create: { creditBalance: 0 } } },
      select: { id: true, apiClient: { select: { id: true } } },
    });
    accountId = account.id;
    apiClientId = account.apiClient!.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  const future = () => new Date(Date.now() + 60_000);
  const balance = async () => (await prisma.apiClient.findUnique({ where: { id: apiClientId } }))!.creditBalance;

  test("an unauthorized intent counts as open only until it expires", async () => {
    const made = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    const whileOpen = await store.countOpen(apiClientId, new Date());
    const afterExpiry = await store.countOpen(apiClientId, new Date(Date.now() + 3_600_000));
    expect(afterExpiry).toBe(whileOpen - 1);
    await prisma.fundingIntent.update({ where: { id: made.id }, data: { status: "EXPIRED" } });
  });

  test("an authorized intent stays open after its window, because a payment may still land", async () => {
    const made = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    await store.setPayer(made.id, apiClientId, `0xlate${Date.now()}`, new Date());
    const whileOpen = await store.countOpen(apiClientId, new Date());
    const afterExpiry = await store.countOpen(apiClientId, new Date(Date.now() + 3_600_000));
    expect(afterExpiry).toBe(whileOpen);
    await prisma.fundingIntent.update({ where: { id: made.id }, data: { status: "EXPIRED" } });
  });

  test("an authorized intent stops counting and matching a week after its window, so stale intents cannot capture later transfers", async () => {
    const payer = `0xstale${Date.now()}`;
    const day = 24 * 3_600_000;
    const stale = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: new Date(Date.now() - 8 * day) });
    const recent = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: new Date(Date.now() - 2 * day) });
    await prisma.fundingIntent.update({ where: { id: stale.id }, data: { payer } });
    await prisma.fundingIntent.update({ where: { id: recent.id }, data: { payer } });

    const matching = await store.openForPayer(payer, new Date());
    expect(matching.map((i) => i.id)).toEqual([recent.id]);

    const counted = await store.countOpen(apiClientId, new Date());
    await prisma.fundingIntent.updateMany({ where: { id: { in: [stale.id, recent.id] } }, data: { status: "EXPIRED" } });
    expect(counted - (await store.countOpen(apiClientId, new Date()))).toBe(1);
  });

  test("cancelling closes an open intent once and removes it from matching and the open count", async () => {
    const payer = `0xcancel${Date.now()}`;
    const made = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    await store.setPayer(made.id, apiClientId, payer, new Date());
    const before = await store.countOpen(apiClientId, new Date());
    expect((await store.openForPayer(payer, new Date())).map((i) => i.id)).toEqual([made.id]);

    expect(await store.cancel(made.id, "someone-else")).toBe(false);
    expect(await store.cancel(made.id, apiClientId)).toBe(true);
    expect(await store.cancel(made.id, apiClientId)).toBe(false);
    expect(await store.openForPayer(payer, new Date())).toEqual([]);
    expect(await store.countOpen(apiClientId, new Date())).toBe(before - 1);
  });

  test("a payer can be set once", async () => {
    const made = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    expect(await store.setPayer(made.id, apiClientId, "0xaaa", new Date())).toBe(true);
    expect(await store.setPayer(made.id, apiClientId, "0xbbb", new Date())).toBe(false);
    expect((await store.get(made.id, apiClientId))!.payer).toBe("0xaaa");
  });

  test("another account cannot read or authorize the intent", async () => {
    const made = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    expect(await store.get(made.id, "someone-else")).toBeNull();
    expect(await store.setPayer(made.id, "someone-else", "0xccc", new Date())).toBe(false);
  });

  test("open intents for a payer come back oldest first", async () => {
    const payer = `0xorder${Date.now()}`;
    const a = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    const b = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    await store.setPayer(b.id, apiClientId, payer, new Date());
    await store.setPayer(a.id, apiClientId, payer, new Date());
    const open = await store.openForPayer(payer, new Date());
    expect(open.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  test("settling credits the balance once and closes the intent", async () => {
    const made = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    const before = await balance();
    const nonce = `0xsettle${Date.now()}`;
    const first = await store.settle({ intent: made, verified: verified(nonce), credited: 100, multiplier: 1 });
    expect(first.outcome).toBe("settled");
    expect(await balance()).toBe(before + 100);
    const again = await store.settle({ intent: made, verified: verified(nonce), credited: 100, multiplier: 1 });
    expect(again.outcome).toBe("not-open");
    expect(await balance()).toBe(before + 100);
  });

  test("a transfer that was already credited leaves the intent open and the balance alone", async () => {
    const nonce = `0xdup${Date.now()}`;
    const one = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    const two = await store.create({ apiClientId, method: "chain-transfer", params: {}, expiresAt: future() });
    await store.settle({ intent: one, verified: verified(nonce), credited: 100, multiplier: 1 });
    const before = await balance();
    const dup = await store.settle({ intent: two, verified: verified(nonce), credited: 100, multiplier: 1 });
    expect(dup.outcome).toBe("duplicate");
    expect((await prisma.fundingIntent.findUnique({ where: { id: two.id } }))!.status).toBe("PENDING");
    expect(await balance()).toBe(before);
  });
});
