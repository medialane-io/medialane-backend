import { describe, expect, test } from "bun:test";
import { refreshIndexedCollection } from "./collections-sync.js";

const ADDRESS = "0x057b4f2390e6239194aa04608133e7d6652d31de318d3b7dfcd63db440579fc1";

function fakeDb(existing: Record<string, unknown> | null) {
  const writes: Array<{ fn: string; args: unknown }> = [];
  const db = {
    collection: {
      findUnique: async () => existing,
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push({ fn: "update", args });
        return { ...existing, ...args.data };
      },
      create: async (args: unknown) => {
        writes.push({ fn: "create", args });
        return args;
      },
      upsert: async (args: unknown) => {
        writes.push({ fn: "upsert", args });
        return args;
      },
    },
  } as never;
  return { db, writes };
}

describe("registering a collection only refreshes one the indexer already knows", () => {
  test("an unknown contract is not added", async () => {
    const { db, writes } = fakeDb(null);
    expect(await refreshIndexedCollection(db, ADDRESS)).toBeNull();
    expect(writes).toEqual([]);
  });

  test("a known collection is queued for metadata and keeps its service", async () => {
    const { db, writes } = fakeDb({ contractAddress: ADDRESS, service: "mip-erc1155", standard: "ERC1155" });
    const refreshed = await refreshIndexedCollection(db, ADDRESS);
    expect(refreshed?.service).toBe("mip-erc1155");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      fn: "update",
      args: {
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: ADDRESS } },
        data: { metadataStatus: "PENDING" },
      },
    });
  });
});
