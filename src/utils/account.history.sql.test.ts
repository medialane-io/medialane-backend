import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("identity changes are recorded", () => {
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
  const eventsOf = (accountId: string) =>
    prisma.accountEvent.findMany({ where: { accountId }, select: { type: true, data: true } });

  test("replacing the email records the old and the new email", async () => {
    const oldEmail = `old-${n}@x.com`;
    const accountId = await newAccount([{ scheme: "email", value: oldEmail }]);
    await account.replaceEmail({ accountId, appId: "MEDIALANE_API", email: `new-${n}@y.com` });

    expect(await eventsOf(accountId)).toEqual([
      { type: "EMAIL_CHANGED", data: { from: oldEmail, to: `new-${n}@y.com`, appId: "MEDIALANE_API" } },
    ]);
  });

  test("an email set for the first time records no previous email", async () => {
    const accountId = await newAccount([]);
    await account.replaceEmail({ accountId, appId: "MEDIALANE_API", email: `first-${n}@y.com` });

    expect(await eventsOf(accountId)).toEqual([
      { type: "EMAIL_CHANGED", data: { from: null, to: `first-${n}@y.com`, appId: "MEDIALANE_API" } },
    ]);
  });

  test("when the event cannot be stored, the email is not changed", async () => {
    const kept = `keep-${n}@x.com`;
    const accountId = await newAccount([{ scheme: "email", value: kept }]);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_event BEFORE INSERT ON "AccountEvent" FOR EACH ROW EXECUTE FUNCTION reject_event()`);
    try {
      await expect(account.replaceEmail({ accountId, appId: "MEDIALANE_API", email: `lost-${n}@y.com` })).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_event ON "AccountEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION reject_event()`);
    }

    const emails = await prisma.identity.findMany({ where: { accountId, scheme: "email" }, select: { value: true } });
    expect(emails).toEqual([{ value: kept }]);
  });
});
