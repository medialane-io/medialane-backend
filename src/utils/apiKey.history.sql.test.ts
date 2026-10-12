import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("API key changes are recorded", () => {
  let prisma: PrismaClient;
  let keys: typeof import("./apiKey.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    keys = await import("./apiKey.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let n = 0;
  const newCredits = async () => {
    n += 1;
    const account = await prisma.account.create({
      data: { publicId: `keys-${n}-${Date.now()}`, apiCredits: { create: {} } },
      select: { id: true, apiCredits: { select: { id: true, accountId: true } } },
    });
    return account.apiCredits!;
  };
  const eventsOf = (accountId: string) =>
    prisma.accountEvent.findMany({ where: { accountId }, orderBy: { createdAt: "asc" }, select: { type: true, data: true } });

  test("creating a key records it and the key it replaced", async () => {
    const credits = await newCredits();
    const first = await keys.replaceApiKey(credits, { prefix: "ml_live_aaaa", keyHash: `h1-${n}` });
    const second = await keys.replaceApiKey(credits, { prefix: "ml_live_bbbb", keyHash: `h2-${n}` }, "main");

    expect(second.label).toBe("main");
    expect(await prisma.apiKey.findMany({ where: { apiCreditsId: credits.id }, select: { id: true } })).toEqual([{ id: second.id }]);
    expect(first.prefix).toBe("ml_live_aaaa");
    expect(await eventsOf(credits.accountId)).toEqual([
      { type: "API_KEY_CREATED", data: { prefix: "ml_live_aaaa", replacedPrefix: null } },
      { type: "API_KEY_CREATED", data: { prefix: "ml_live_bbbb", replacedPrefix: "ml_live_aaaa" } },
    ]);
  });

  test("deleting a key records it", async () => {
    const credits = await newCredits();
    const key = await keys.replaceApiKey(credits, { prefix: "ml_live_cccc", keyHash: `h3-${n}` });

    expect(await keys.deleteApiKey(credits, key.id)).toBe(true);
    expect(await prisma.apiKey.count({ where: { apiCreditsId: credits.id } })).toBe(0);
    expect((await eventsOf(credits.accountId)).at(-1)).toEqual({ type: "API_KEY_DELETED", data: { prefix: "ml_live_cccc" } });
  });

  test("deleting a key of another account changes nothing", async () => {
    const owner = await newCredits();
    const other = await newCredits();
    const key = await keys.replaceApiKey(owner, { prefix: "ml_live_dddd", keyHash: `h4-${n}` });

    expect(await keys.deleteApiKey(other, key.id)).toBe(false);
    expect(await prisma.apiKey.count({ where: { id: key.id } })).toBe(1);
    expect(await eventsOf(other.accountId)).toEqual([]);
  });
});
