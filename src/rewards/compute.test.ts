import { describe, expect, test } from "bun:test";
import { computeSoldOutBadges, computeFullSetBadges, computeDiamondHandsBadges } from "./compute.js";
import { normalizeAddress } from "../utils/starknet.js";

const OWNER_A = normalizeAddress("STARKNET", "0xa1a");
const OWNER_B = normalizeAddress("STARKNET", "0xb2b");
const CONTRACT_1 = normalizeAddress("STARKNET", "0xc11");
const CONTRACT_2 = normalizeAddress("STARKNET", "0xc22");

function callCounter() {
  const calls: string[] = [];
  return { calls, record: (name: string) => calls.push(name) };
}

describe("computeSoldOutBadges", () => {
  test("awards the collection owner once a drop's claims meet its max supply, using one groupBy instead of one count per drop", async () => {
    const { calls, record } = callCounter();
    const db = {
      dropClaimConditions: {
        async findMany() {
          record("dropClaimConditions.findMany");
          return [
            { collectionAddress: CONTRACT_1, maxSupply: "2" },
            { collectionAddress: CONTRACT_2, maxSupply: "10" },
          ];
        },
      },
      transfer: {
        async groupBy() {
          record("transfer.groupBy");
          return [
            { contractAddress: CONTRACT_1, _count: { id: 2 } },
            { contractAddress: CONTRACT_2, _count: { id: 3 } },
          ];
        },
      },
      collection: {
        async findMany() {
          record("collection.findMany");
          return [{ contractAddress: CONTRACT_1, owner: OWNER_A }];
        },
      },
    } as never;

    const result = await computeSoldOutBadges(db);

    expect(result).toEqual(new Set([OWNER_A]));
    expect(calls).toEqual(["dropClaimConditions.findMany", "transfer.groupBy", "collection.findMany"]);
  });

  test("no drops — makes no follow-up queries", async () => {
    const { calls, record } = callCounter();
    const db = {
      dropClaimConditions: {
        async findMany() {
          record("dropClaimConditions.findMany");
          return [];
        },
      },
      transfer: { async groupBy() { record("transfer.groupBy"); return []; } },
      collection: { async findMany() { record("collection.findMany"); return []; } },
    } as never;

    const result = await computeSoldOutBadges(db);

    expect(result).toEqual(new Set());
    expect(calls).toEqual(["dropClaimConditions.findMany"]);
  });
});

describe("computeFullSetBadges", () => {
  test("awards a holder who owns every token in a contract, using batched groupBys instead of one count+groupBy per contract", async () => {
    const { calls, record } = callCounter();
    const db = {
      token: {
        async groupBy() {
          record("token.groupBy");
          return [
            { contractAddress: CONTRACT_1, _count: { id: 3 } },
            { contractAddress: CONTRACT_2, _count: { id: 5 } },
          ];
        },
      },
      tokenBalance: {
        async groupBy() {
          record("tokenBalance.groupBy");
          return [
            { owner: OWNER_A, contractAddress: CONTRACT_1, _count: { tokenId: 3 } },
            { owner: OWNER_B, contractAddress: CONTRACT_2, _count: { tokenId: 2 } },
          ];
        },
      },
    } as never;

    const result = await computeFullSetBadges(db, [CONTRACT_1, CONTRACT_2]);

    expect(result).toEqual(new Set([OWNER_A]));
    expect(calls).toEqual(["token.groupBy", "tokenBalance.groupBy"]);
  });

  test("no contracts — makes no queries", async () => {
    const db = {
      token: { async groupBy() { throw new Error("should not be called"); } },
      tokenBalance: { async groupBy() { throw new Error("should not be called"); } },
    } as never;

    const result = await computeFullSetBadges(db, []);

    expect(result).toEqual(new Set());
  });
});

describe("computeDiamondHandsBadges", () => {
  test("awards a receiver who never sent the token on again, using one batched query instead of one count per old receipt", async () => {
    const { calls, record } = callCounter();
    const oldReceipt = { toAddress: OWNER_A, contractAddress: CONTRACT_1, tokenId: "1", createdAt: new Date("2026-01-01") };
    const stillHeldReceipt = { toAddress: OWNER_B, contractAddress: CONTRACT_2, tokenId: "2", createdAt: new Date("2026-01-01") };
    const db = {
      transfer: {
        async findMany(args: { where?: { createdAt?: unknown } }) {
          if (args.where?.createdAt) {
            record("transfer.findMany:oldReceipts");
            return [oldReceipt, stillHeldReceipt];
          }
          record("transfer.findMany:allForTokens");

          return [{ contractAddress: CONTRACT_1, tokenId: "1", fromAddress: OWNER_A, createdAt: new Date("2026-02-01") }];
        },
      },
    } as never;

    const result = await computeDiamondHandsBadges(db);

    expect(result).toEqual(new Set([OWNER_B]));
    expect(calls).toEqual(["transfer.findMany:oldReceipts", "transfer.findMany:allForTokens"]);
  });

  test("no old receipts — makes no follow-up query", async () => {
    const { calls, record } = callCounter();
    const db = {
      transfer: {
        async findMany() {
          record("transfer.findMany:oldReceipts");
          return [];
        },
      },
    } as never;

    const result = await computeDiamondHandsBadges(db);

    expect(result).toEqual(new Set());
    expect(calls).toEqual(["transfer.findMany:oldReceipts"]);
  });
});
