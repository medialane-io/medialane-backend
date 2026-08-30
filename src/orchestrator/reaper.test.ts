import { test, expect } from "bun:test";
import { expiredOrderWhere } from "./reaper.js";

const NOW_MS = 1_800_000_000_000;
const NOW_S = BigInt(Math.floor(NOW_MS / 1000));

function matches(where: ReturnType<typeof expiredOrderWhere>, endTime: bigint, status: string): boolean {
  return status === where.status && endTime > where.endTime.gt && endTime < where.endTime.lt;
}

test("only ACTIVE orders are considered", () => {
  expect(expiredOrderWhere(NOW_MS).status).toBe("ACTIVE");
  expect(matches(expiredOrderWhere(NOW_MS), NOW_S - 1n, "FULFILLED")).toBe(false);
  expect(matches(expiredOrderWhere(NOW_MS), NOW_S - 1n, "CANCELLED")).toBe(false);
});

test("an order whose endTime has passed is expired", () => {
  expect(matches(expiredOrderWhere(NOW_MS), NOW_S - 1n, "ACTIVE")).toBe(true);
});

test("an order still inside its window is left alone", () => {
  expect(matches(expiredOrderWhere(NOW_MS), NOW_S + 3600n, "ACTIVE")).toBe(false);
});

test("endTime 0 means no expiry and is never swept", () => {
  expect(matches(expiredOrderWhere(NOW_MS), 0n, "ACTIVE")).toBe(false);
});

test("the boundary second is not yet expired", () => {
  expect(matches(expiredOrderWhere(NOW_MS), NOW_S, "ACTIVE")).toBe(false);
});

test("the comparison is in seconds, not milliseconds", () => {
  // A millisecond comparison would treat every realistic endTime as expired.
  expect(expiredOrderWhere(NOW_MS).endTime.lt).toBe(NOW_S);
  expect(matches(expiredOrderWhere(NOW_MS), NOW_S + 1n, "ACTIVE")).toBe(false);
});
