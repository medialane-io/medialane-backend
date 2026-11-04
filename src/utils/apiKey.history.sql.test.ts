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
  const RUN = Date.now();
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

  test("creating a key records it and keeps the key it replaced as REVOKED", async () => {
    const credits = await newCredits();
    const first = (await keys.replaceApiKey(credits, null, { prefix: "ml_live_aaaa", keyHash: `h1-${n}-${RUN}` }))!;
    const second = (await keys.replaceApiKey(credits, first.id, { prefix: "ml_live_bbbb", keyHash: `h2-${n}-${RUN}` }, "main"))!;

    expect(second.label).toBe("main");
    expect(await prisma.apiKey.findMany({ where: { apiCreditsId: credits.id }, orderBy: { createdAt: "asc" }, select: { id: true, status: true } })).toEqual([
      { id: first.id, status: "REVOKED" },
      { id: second.id, status: "ACTIVE" },
    ]);
    expect(first.prefix).toBe("ml_live_aaaa");
    expect(await eventsOf(credits.accountId)).toEqual([
      { type: "API_KEY_CREATED", data: { prefix: "ml_live_aaaa", replacedPrefix: null } },
      { type: "API_KEY_CREATED", data: { prefix: "ml_live_bbbb", replacedPrefix: "ml_live_aaaa" } },
    ]);
  });

  test("a replacement over a key that is no longer current changes nothing", async () => {
    const credits = await newCredits();
    const first = (await keys.replaceApiKey(credits, null, { prefix: "ml_live_ffff", keyHash: `h6-${n}-${RUN}` }))!;
    expect(await keys.replaceApiKey(credits, null, { prefix: "ml_live_gggg", keyHash: `h7-${n}-${RUN}` })).toBeNull();
    expect(await prisma.apiKey.findMany({ where: { apiCreditsId: credits.id, status: "ACTIVE" }, select: { id: true } })).toEqual([{ id: first.id }]);
  });

  test("revoking a key keeps it as REVOKED and records it", async () => {
    const credits = await newCredits();
    const key = (await keys.replaceApiKey(credits, null, { prefix: "ml_live_cccc", keyHash: `h3-${n}-${RUN}` }))!;

    expect(await keys.revokeApiKey(credits, key.id)).toBe(true);
    expect(await prisma.apiKey.findMany({ where: { apiCreditsId: credits.id }, select: { id: true, status: true } })).toEqual([{ id: key.id, status: "REVOKED" }]);
    expect((await eventsOf(credits.accountId)).at(-1)).toEqual({ type: "API_KEY_DELETED", data: { prefix: "ml_live_cccc" } });
  });

  test("revoking a key of another account changes nothing", async () => {
    const owner = await newCredits();
    const other = await newCredits();
    const key = (await keys.replaceApiKey(owner, null, { prefix: "ml_live_dddd", keyHash: `h4-${n}-${RUN}` }))!;

    expect(await keys.revokeApiKey(other, key.id)).toBe(false);
    expect(await prisma.apiKey.findUnique({ where: { id: key.id }, select: { status: true } })).toEqual({ status: "ACTIVE" });
    expect(await eventsOf(other.accountId)).toEqual([]);
  });
});
