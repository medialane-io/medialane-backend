import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccountStatus, PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!databaseUrl)("account status changes are recorded", () => {
  let prisma: PrismaClient;
  let account: typeof import("./account.js");
  let unverified: typeof import("../orchestrator/unverifiedAccounts.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    account = await import("./account.js");
    unverified = await import("../orchestrator/unverifiedAccounts.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let n = 0;
  const newAccount = async (status: AccountStatus, createdAt: Date, emailApp: string | null) => {
    n += 1;
    const created = await prisma.account.create({
      data: {
        publicId: `status-${n}-${Date.now()}`,
        status,
        createdAt,
        identities: emailApp ? { create: [{ scheme: "email", value: `s${n}-${Date.now()}@x.com`, appId: emailApp }] } : undefined,
      },
      select: { id: true },
    });
    return created.id;
  };
  const statusOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).status;
  const eventsOf = (accountId: string) =>
    prisma.accountEvent.findMany({ where: { accountId }, select: { type: true, data: true } });

  test("activating a pending account records the change", async () => {
    const id = await newAccount("PENDING", new Date(), null);
    await account.activateAccount(id);
    expect(await statusOf(id)).toBe("ACTIVE");
    expect(await eventsOf(id)).toEqual([{ type: "STATUS_CHANGED", data: { from: "PENDING", to: "ACTIVE" } }]);
  });

  test("activating an account that is already active records nothing", async () => {
    const id = await newAccount("ACTIVE", new Date(), null);
    await account.activateAccount(id);
    expect(await eventsOf(id)).toEqual([]);
  });

  test("only io's pending accounts past the window become inactive, each with its own event", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 8 * DAY);
    const expired = await newAccount("PENDING", old, "MEDIALANE_IO");
    const recent = await newAccount("PENDING", new Date(now.getTime() - 2 * DAY), "MEDIALANE_IO");
    const otherApp = await newAccount("PENDING", old, "MEDIALANE_PORTAL");
    const active = await newAccount("ACTIVE", old, "MEDIALANE_IO");

    expect(await unverified.deactivateExpiredPending(now)).toBeGreaterThanOrEqual(1);

    expect(await statusOf(expired)).toBe("INACTIVE");
    expect(await eventsOf(expired)).toEqual([{ type: "STATUS_CHANGED", data: { from: "PENDING", to: "INACTIVE" } }]);
    for (const untouched of [recent, otherApp, active]) {
      expect(await eventsOf(untouched)).toEqual([]);
    }
    expect(await statusOf(recent)).toBe("PENDING");
    expect(await statusOf(otherApp)).toBe("PENDING");
    expect(await statusOf(active)).toBe("ACTIVE");
  });
});
