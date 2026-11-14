import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAccountsRoutes, type AccountsDeps, type AccountRow } from "./accounts.js";

const ROWS: AccountRow[] = [
  { address: "0x0000000000000000000000000000000000000000000000000000000000000abc", collections: 2, assets: 5 },
  { address: "0x0000000000000000000000000000000000000000000000000000000000000def", collections: 0, assets: 1 },
];

function makeApp(deps: AccountsDeps) {
  const app = new Hono<AppEnv>();
  app.route("/v1/accounts", createAccountsRoutes(deps));
  return app;
}

test("lists accounts with their counts and the page meta", async () => {
  const calls: unknown[][] = [];
  const app = makeApp({
    list: async (...args) => {
      calls.push(args);
      return { rows: ROWS, total: 42 };
    },
  });

  const res = await app.request("/v1/accounts?page=2&limit=2");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: ROWS, meta: { page: 2, limit: 2, total: 42 } });
  expect(calls).toEqual([["STARKNET", "", 2, 2]]);
});

test("search matches hexadecimal text, with or without the 0x prefix, case-insensitively", async () => {
  const hexes: string[] = [];
  const app = makeApp({
    list: async (_chain, hex) => {
      hexes.push(hex);
      return { rows: [], total: 0 };
    },
  });

  await app.request("/v1/accounts?search=0xABC");
  await app.request("/v1/accounts?search=def");
  expect(hexes).toEqual(["abc", "def"]);
});

test("search that is not hexadecimal finds nothing and does not query", async () => {
  let called = false;
  const app = makeApp({
    list: async () => {
      called = true;
      return { rows: ROWS, total: 2 };
    },
  });

  const res = await app.request("/v1/accounts?search=maria");
  expect(await res.json()).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } });
  expect(called).toBe(false);
});

test("the page size is capped", async () => {
  let limit = 0;
  const app = makeApp({
    list: async (_chain, _hex, l) => {
      limit = l;
      return { rows: [], total: 0 };
    },
  });
  await app.request("/v1/accounts?limit=500");
  expect(limit).toBe(50);
});
