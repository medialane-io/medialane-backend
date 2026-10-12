import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("account events against Postgres", () => {
  let prisma: PrismaClient;
  let events: typeof import("./accountEvents.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    events = await import("./accountEvents.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let n = 0;
  const newAccount = async () =>
    (await prisma.account.create({ data: { publicId: `events-${++n}-${Date.now()}` }, select: { id: true } })).id;

  test("a recorded event is stored with its account, type and data", async () => {
    const accountId = await newAccount();
    await events.recordAccountEvent(prisma, accountId, "EMAIL_CHANGED", { from: "a@x.com", to: "b@y.com", appId: "io" });
    const stored = await prisma.accountEvent.findMany({ where: { accountId } });
    expect(stored.map((e) => [e.type, e.data])).toEqual([["EMAIL_CHANGED", { from: "a@x.com", to: "b@y.com", appId: "io" }]]);
  });

  test("a stored event cannot be changed", async () => {
    const accountId = await newAccount();
    await events.recordAccountEvent(prisma, accountId, "STATUS_CHANGED", { from: "PENDING", to: "ACTIVE" });
    await expect(Promise.resolve(prisma.accountEvent.updateMany({ where: { accountId }, data: { data: {} } }))).rejects.toThrow();
  });

  test("a stored event cannot be deleted", async () => {
    const accountId = await newAccount();
    await events.recordAccountEvent(prisma, accountId, "STATUS_CHANGED", { from: "PENDING", to: "ACTIVE" });
    await expect(Promise.resolve(prisma.accountEvent.deleteMany({ where: { accountId } }))).rejects.toThrow();
    expect(await prisma.accountEvent.count({ where: { accountId } })).toBe(1);
  });

  test("an account with events cannot be deleted", async () => {
    const accountId = await newAccount();
    await events.recordAccountEvent(prisma, accountId, "STATUS_CHANGED", { from: "PENDING", to: "ACTIVE" });
    await expect(Promise.resolve(prisma.account.delete({ where: { id: accountId } }))).rejects.toThrow();
  });
});
