import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
import { bill, billedUnits, drift } from "./usage.js";

async function run(fn: (c: Parameters<typeof bill>[0]) => void) {
  const app = new Hono<AppEnv>();
  let seen = -1;
  app.get("/", (c) => {
    fn(c);
    seen = billedUnits(c, 7);
    return c.json({});
  });
  await app.request("/");
  return seen;
}

test("a handler that says nothing is billed what the route implied", async () => {
  expect(await run(() => {})).toBe(7);
});

test("a handler that did nothing is billed nothing", async () => {
  expect(await run((c) => bill(c, 0))).toBe(0);
});

test("a handler reporting its real size overrides the route", async () => {
  expect(await run((c) => bill(c, 3))).toBe(3);
});

test("a negative or fractional count cannot be billed", async () => {
  expect(await run((c) => bill(c, -4))).toBe(0);
  expect(await run((c) => bill(c, 2.9))).toBe(2);
});

test("a balance that matches the ledger has no drift", () => {
  expect(drift(100, 30, 70)).toBe(0);
});

test("credits that left the balance without a usage row show as drift", () => {
  expect(drift(100, 0, 70)).toBe(-30);
});

test("credits added to the balance without a payment show as drift", () => {
  expect(drift(100, 30, 90)).toBe(20);
});
