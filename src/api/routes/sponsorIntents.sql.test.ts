import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("claiming intents for sponsorship", () => {
  let prisma: PrismaClient;
  let mod: typeof import("./sponsorIntents.js");

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    mod = await import("./sponsorIntents.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const intent = (requester: string) =>
    prisma.transactionIntent.create({
      data: { type: "TRANSFER_TOKEN", status: "SIGNED", requester, accountId: "app", typedData: {}, calls: [], expiresAt: new Date(Date.now() + 60_000) },
      select: { id: true },
    });

  test("a claim that overlaps another request's claim takes nothing and releases nothing of theirs", async () => {
    const a = await intent("0x1");
    const b = await intent("0x1");
    expect(await mod.prismaSponsorIntentDeps.claim([a.id])).toBe(true);
    expect(await mod.prismaSponsorIntentDeps.claim([a.id, b.id])).toBe(false);
    const rows = await prisma.transactionIntent.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, status: true } });
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status[a.id]).toBe("SUBMITTED");
    expect(status[b.id]).toBe("SIGNED");
  });

  test("release puts back only rows with no transaction yet", async () => {
    const a = await intent("0x2");
    expect(await mod.prismaSponsorIntentDeps.claim([a.id])).toBe(true);
    await mod.prismaSponsorIntentDeps.release([a.id]);
    expect((await prisma.transactionIntent.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("SIGNED");
  });
});
