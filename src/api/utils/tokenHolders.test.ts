import { expect, test } from "bun:test";
import { tokenHolders, TOKEN_HOLDERS_LIMIT } from "./tokenHolders.js";

function fakeDb() {
  const queries: unknown[][] = [];
  const db = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(values);
      return Promise.resolve(strings.join("").includes("COUNT(*)") ? [{ holderCount: 3, supply: "12" }] : [{ owner: "0x1", amount: "9" }]);
    },
    tokenBalance: {},
  };
  return { db: db as never, queries };
}

test("the first page reads the default number of holders", async () => {
  const { db, queries } = fakeDb();
  const res = await tokenHolders("STARKNET", "0xa", "1", {}, db);
  expect(queries[0].slice(-2)).toEqual([TOKEN_HOLDERS_LIMIT, 0]);
  expect(res).toEqual({ holders: [{ owner: "0x1", amount: "9" }], holderCount: 3, supply: "12" });
});

test("later pages skip the holders before them", async () => {
  const { db, queries } = fakeDb();
  await tokenHolders("STARKNET", "0xa", "1", { page: 3, limit: 20 }, db);
  expect(queries[0].slice(-2)).toEqual([20, 40]);
});
