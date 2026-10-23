import { describe, expect, test } from "bun:test";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { pageQuery } from "./page.js";

async function read(query: string, opts?: Parameters<typeof pageQuery>[0]) {
  const app = new Hono();
  app.get("/", zValidator("query", pageQuery(opts)), (c) => c.json(c.req.valid("query")));
  const res = await app.request(`/${query}`);
  return res.json();
}

describe("pageQuery", () => {
  test("no query gives the defaults", async () => {
    expect(await read("")).toEqual({ page: 1, limit: 20, skip: 0 });
  });

  test("a valid page and limit pass through and give the skip", async () => {
    expect(await read("?page=3&limit=10")).toEqual({ page: 3, limit: 10, skip: 20 });
  });

  test.each([
    ["abc", 20],
    ["", 20],
    ["0", 1],
    ["-5", 1],
    ["2.5", 2],
    ["1e3", 100],
    ["500", 100],
  ])("limit=%s gives %d with defaults 20 and 100", async (raw, expected) => {
    expect((await read(`?limit=${raw}`)).limit).toBe(expected);
  });

  test("a repeated limit falls back to the default", async () => {
    expect((await read("?limit=1&limit=2")).limit).toBe(20);
  });

  test.each([
    ["0", 1],
    ["-2", 1],
    ["abc", 1],
    ["", 1],
    ["2.9", 2],
  ])("page=%s gives %d", async (raw, expected) => {
    expect((await read(`?page=${raw}`)).page).toBe(expected);
  });

  test("a route's own default and cap are used", async () => {
    expect((await read("", { defaultLimit: 24, maxLimit: 48 })).limit).toBe(24);
    expect((await read("?limit=100", { defaultLimit: 24, maxLimit: 48 })).limit).toBe(48);
  });
});
