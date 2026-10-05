import { test, expect } from "bun:test";
import { deactivateExpiredPending, isExpired, IO_VERIFICATION_DAYS, verificationDeadline } from "./unverifiedAccounts.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

test("an io email signup has seven days to verify", () => {
  expect(IO_VERIFICATION_DAYS).toBe(7);
});

test("a pending account inside the window is left alone", () => {
  expect(isExpired(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe(false);
});

test("a pending account past the window has expired", () => {
  expect(isExpired(new Date(NOW.getTime() - 8 * DAY), NOW)).toBe(true);
});

type Call = { where: { createdAt: { lt: Date }; identities: { some: { app: string } } } };

function fakeDb(apps: { name: string; emailConfirmDays: number | null }[], counts: Record<string, number>) {
  const calls: Call[] = [];
  const db = {
    app: { findMany: async () => apps },
    account: {
      updateMany: async (args: Call) => {
        calls.push(args);
        return { count: counts[args.where.identities.some.app] ?? 0 };
      },
    },
  };
  return { db, calls };
}

test("an app's pending accounts past its window become inactive, scoped to that app", async () => {
  const { db, calls } = fakeDb([{ name: "MEDIALANE_IO", emailConfirmDays: 7 }], { MEDIALANE_IO: 2 });
  expect(await deactivateExpiredPending(NOW, db)).toBe(2);
  expect(calls).toEqual([
    {
      where: {
        status: "PENDING",
        createdAt: { lt: new Date(NOW.getTime() - 7 * DAY) },
        identities: { some: { scheme: "email", app: "MEDIALANE_IO" } },
      },
      data: { status: "INACTIVE" },
    },
  ] as never);
});

test("each app uses its own window, and the closed accounts are added up", async () => {
  const { db, calls } = fakeDb(
    [
      { name: "APP_A", emailConfirmDays: 7 },
      { name: "APP_B", emailConfirmDays: 3 },
    ],
    { APP_A: 1, APP_B: 4 },
  );
  expect(await deactivateExpiredPending(NOW, db)).toBe(5);
  expect(calls.map((c) => [c.where.identities.some.app, c.where.createdAt.lt.getTime()])).toEqual([
    ["APP_A", NOW.getTime() - 7 * DAY],
    ["APP_B", NOW.getTime() - 3 * DAY],
  ]);
});

test("when no app has a confirmation window nothing is closed", async () => {
  const { db, calls } = fakeDb([], {});
  expect(await deactivateExpiredPending(NOW, db)).toBe(0);
  expect(calls).toEqual([]);
});

test("the deadline is exactly seven days after the account was made", () => {
  expect(verificationDeadline(new Date("2026-10-03T12:00:00Z")).toISOString()).toBe("2026-10-10T12:00:00.000Z");
});
