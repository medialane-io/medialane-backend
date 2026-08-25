import { test, expect } from "bun:test";
import { buildActivityWhere, loadHiddenContentFilter, clearHiddenContentCache, HIDDEN_CONTENT_TTL_MS } from "./activities.js";
import { chainWhere } from "../utils/chainFilter.js";

function fakeDb(callCounts: { count: number }) {
  return {
    collection: {
      async findFirst() {
        callCounts.count += 1;
        return null;
      },
      async findMany() {
        return [];
      },
    },
    token: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [];
      },
    },
  } as never;
}

test("loadHiddenContentFilter caches across calls within the TTL — recomputing on every request would scale with total moderated content, not traffic", async () => {
  clearHiddenContentCache();
  const callCounts = { count: 0 };
  let now = 1_000_000;
  const deps = { db: fakeDb(callCounts), now: () => now, ttlMs: HIDDEN_CONTENT_TTL_MS };

  await loadHiddenContentFilter(deps);
  await loadHiddenContentFilter(deps);

  expect(callCounts.count).toBe(1);
});

test("loadHiddenContentFilter recomputes once the TTL has elapsed", async () => {
  clearHiddenContentCache();
  const callCounts = { count: 0 };
  let now = 1_000_000;
  const deps = { db: fakeDb(callCounts), now: () => now, ttlMs: HIDDEN_CONTENT_TTL_MS };

  await loadHiddenContentFilter(deps);
  now += HIDDEN_CONTENT_TTL_MS + 1;
  await loadHiddenContentFilter(deps);

  expect(callCounts.count).toBe(2);
});

const CHAIN = { chain: "STARKNET" as const };
const CONTRACT = "0x0000000000000000000000000000000000000000000000000000000000000abc";

test("no contract param — filters stay chain-only (existing global-feed behavior)", () => {
  const { transferWhere, orderWhere } = buildActivityWhere({ chainFilter: CHAIN });
  expect(transferWhere).toEqual({ ...chainWhere(CHAIN) });
  expect(orderWhere).toEqual({ ...chainWhere(CHAIN) });
});

test("contract param — scopes both tables to that contract, skips hiddenContractFilter", () => {
  const { transferWhere, orderWhere } = buildActivityWhere({
    chainFilter: CHAIN,
    contract: CONTRACT,
    hiddenContractFilter: { notIn: [CONTRACT] },
  });
  expect(transferWhere.contractAddress).toBe(CONTRACT);
  expect(orderWhere.nftContract).toBe(CONTRACT);
});

test("mint/transfer type still narrows fromAddress alongside a contract filter", () => {
  const { transferWhere } = buildActivityWhere({ chainFilter: CHAIN, type: "mint", contract: CONTRACT });
  expect(transferWhere.contractAddress).toBe(CONTRACT);
  expect(transferWhere.fromAddress).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
});

test("no contract param — hiddenContractFilter still applies (unchanged global-feed safety)", () => {
  const { transferWhere, orderWhere } = buildActivityWhere({
    chainFilter: CHAIN,
    hiddenContractFilter: { notIn: [CONTRACT] },
  });
  expect(transferWhere.contractAddress).toEqual({ notIn: [CONTRACT] });
  expect(orderWhere.nftContract).toEqual({ notIn: [CONTRACT] });
});
