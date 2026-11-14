import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAccountsRoutes, type AccountsDeps, type AccountRow } from "./accounts.js";

const ROWS: AccountRow[] = [
  { address: "0x0000000000000000000000000000000000000000000000000000000000000abc", image: "ipfs://a", ipType: "Art" },
  { address: "0x0000000000000000000000000000000000000000000000000000000000000def", image: null, ipType: null },
];

function makeApp(deps: AccountsDeps) {
  const app = new Hono<AppEnv>();
  app.route("/v1/accounts", createAccountsRoutes(deps));
  return app;
}

const empty = async () => ({ rows: [], total: 0 });

test("lists accounts with their featured asset and the page meta", async () => {
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
  expect(calls).toEqual([["STARKNET", { hex: "", ipType: "" }, 2, 2]]);
});

test("search matches hexadecimal text, with or without the 0x prefix, case-insensitively", async () => {
  const hexes: string[] = [];
  const app = makeApp({
    list: async (_chain, query) => {
      hexes.push(query.hex);
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

test("the type of work is passed on as a lowercase slug", async () => {
  const types: string[] = [];
  const app = makeApp({
    list: async (_chain, query) => {
      types.push(query.ipType);
      return { rows: [], total: 0 };
    },
  });
  await app.request("/v1/accounts?ipType=Audio");
  expect(types).toEqual(["audio"]);
});

test("the page size is capped", async () => {
  let limit = 0;
  const app = makeApp({
    list: async (_chain, _query, l) => {
      limit = l;
      return empty();
    },
  });
  await app.request("/v1/accounts?limit=500");
  expect(limit).toBe(50);
});
