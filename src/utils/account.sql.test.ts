import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("email accounts against Postgres", () => {
  let prisma: PrismaClient;
  let account: typeof import("./account.js");
  const appId = "MEDIALANE_IO";

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    account = await import("./account.js");
    await prisma.app.upsert({ where: { id: appId }, create: { id: appId, name: "Medialane" }, update: {} });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function inactiveAccountWith(email: string) {
    return prisma.account.create({
      data: {
        publicId: `inactive-${email}`,
        status: "INACTIVE",
        identities: { create: { scheme: "email", value: email, appId } },
      },
      select: { id: true, identities: true },
    });
  }

  test("an inactive account is invisible to the email lookup", async () => {
    await inactiveAccountWith("gone@example.com");
    expect(await account.findLiveAccountIdByEmail("gone@example.com", appId)).toBeNull();
  });

  test("a new account gets the email and the inactive account keeps it untouched", async () => {
    const old = await inactiveAccountWith("again@example.com");

    const created = await account.ensureAccountForEmail("Again@example.com", appId);

    expect(created.created).toBe(true);
    expect(created.accountId).not.toBe(old.id);
    expect(await account.findLiveAccountIdByEmail("again@example.com", appId)).toBe(created.accountId);
    const after = await prisma.account.findUnique({ where: { id: old.id }, select: { status: true, identities: true } });
    expect(after).toEqual({ status: "INACTIVE", identities: old.identities });
  });

  test("a live account is returned, not duplicated", async () => {
    const first = await account.ensureAccountForEmail("live@example.com", appId);
    const second = await account.ensureAccountForEmail("live@example.com", appId);
    expect(second).toEqual({ accountId: first.accountId, created: false });
  });

  test("concurrent sign-ups with one email create one account", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => account.ensureAccountForEmail("race@example.com", appId)),
    );
    expect(new Set(results.map((r) => r.accountId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });
});
