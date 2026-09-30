import { test, expect } from "bun:test";
import { deactivateExpiredPending, isExpired, IO_VERIFICATION_DAYS } from "./unverifiedAccounts.js";

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

test("only pending accounts past the window become inactive; no other account is touched", async () => {
  const calls: unknown[] = [];
  const db = {
    account: {
      updateMany: async (args: unknown) => {
        calls.push(args);
        return { count: 2 };
      },
    },
  };
  expect(await deactivateExpiredPending(NOW, db)).toBe(2);
  expect(calls).toEqual([
    {
      where: { status: "PENDING", createdAt: { lt: new Date(NOW.getTime() - 7 * DAY) } },
      data: { status: "INACTIVE" },
    },
  ]);
});
