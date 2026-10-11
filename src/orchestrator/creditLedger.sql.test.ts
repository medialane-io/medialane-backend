import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;
const OPENING_SQL = readFileSync("prisma/migrations/20261011100000_credit_entry_opening/migration.sql", "utf8");

describe.skipIf(!databaseUrl)("opening balances and reconciliation", () => {
  let prisma: PrismaClient;
  let ledger: typeof import("./creditLedger.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    ledger = await import("./creditLedger.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("opening entries explain balances from before the ledger, including spends made since", async () => {
    const before = await prisma.apiCredits.create({ data: { creditBalance: 500, account: { create: { publicId: `open-a-${Date.now()}` } } } });
    const spentSince = await prisma.apiCredits.create({ data: { creditBalance: 300, account: { create: { publicId: `open-b-${Date.now()}` } } } });
    const { debitCredits } = await import("../payments/credits.js");
    await debitCredits(spentSince.id, 100);

    await prisma.$executeRawUnsafe(OPENING_SQL);

    const opening = await prisma.creditEntry.findMany({ where: { kind: "OPENING", apiCreditsId: { in: [before.id, spentSince.id] } } });
    expect(Object.fromEntries(opening.map((e) => [e.apiCreditsId, e.credits]))).toEqual({ [before.id]: 500, [spentSince.id]: 300 });
    const { balances } = await ledger.findLedgerDifferences();
    expect(balances.filter((d) => [before.id, spentSince.id].includes(d.apiCreditsId))).toEqual([]);
  });

  test("a balance changed outside the ledger is reported with its difference", async () => {
    const credits = await prisma.apiCredits.create({ data: { creditBalance: 0, account: { create: { publicId: `drift-${Date.now()}` } } } });
    await prisma.apiCredits.update({ where: { id: credits.id }, data: { creditBalance: 42 } });
    const { balances } = await ledger.findLedgerDifferences();
    expect(balances.find((d) => d.apiCreditsId === credits.id)).toEqual({ apiCreditsId: credits.id, balance: 42, ledger: 0 });
  });

  test("a PAYMENT entry without a settled payment is reported", async () => {
    const credits = await prisma.apiCredits.create({ data: { creditBalance: 0, account: { create: { publicId: `pay-${Date.now()}` } } } });
    const entry = await prisma.creditEntry.create({ data: { apiCreditsId: credits.id, kind: "PAYMENT", credits: 0, paymentId: "missing" } });
    const { payments } = await ledger.findLedgerDifferences();
    expect(payments.map((p) => p.entryId)).toContain(entry.id);
  });
});
