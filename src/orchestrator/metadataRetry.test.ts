import { describe, expect, mock, test } from "bun:test";
import type { WorkItem } from "./worker.js";

mock.module("../db/client.js", () => ({ default: {} }));

const { retryFailedMetadata } = await import("./metadataRetry.js");

type Row = { id: string; chain: "STARKNET"; contractAddress: string; tokenId?: string };

function pagedTable(rows: Row[]) {
  const calls: unknown[] = [];
  const findMany = async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
    calls.push(args);
    const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
    return rows.slice(start, start + args.take);
  };
  return { findMany, calls };
}

const tokens = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${String(i).padStart(4, "0")}`, chain: "STARKNET", contractAddress: "0xc", tokenId: String(i) }));
const collections = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(4, "0")}`, chain: "STARKNET", contractAddress: `0x${i}` }));

describe("retryFailedMetadata", () => {
  test("re-queues every failed token and collection, not only the first page", async () => {
    const tokenTable = pagedTable(tokens(250));
    const collectionTable = pagedTable(collections(112));
    const queued: WorkItem[] = [];

    const result = await retryFailedMetadata({
      token: { findMany: tokenTable.findMany as never },
      collection: { findMany: collectionTable.findMany as never },
      enqueue: (item) => queued.push(item),
    });

    expect(result).toEqual({ tokens: 250, collections: 112 });
    expect(queued.filter((q) => q.type === "METADATA_FETCH")).toHaveLength(250);
    expect(queued.filter((q) => q.type === "COLLECTION_METADATA_FETCH")).toHaveLength(112);
    expect(new Set(queued.map((q) => JSON.stringify(q))).size).toBe(362);
    expect(tokenTable.calls).toHaveLength(3);
    expect(collectionTable.calls).toHaveLength(2);
  });

  test("tokens and collections not yet read are always queued; failed ones only in their first 7 days", async () => {
    const tokenTable = pagedTable(tokens(1));
    const collectionTable = pagedTable([]);
    const now = Date.UTC(2026, 10, 28);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    await retryFailedMetadata({
      token: { findMany: tokenTable.findMany as never },
      collection: { findMany: collectionTable.findMany as never },
      enqueue: () => {},
      now: () => now,
    });
    expect(tokenTable.calls[0]).toMatchObject({
      where: { OR: [{ metadataStatus: "PENDING" }, { metadataStatus: "FAILED", createdAt: { gt: weekAgo } }] },
    });
    expect(collectionTable.calls[0]).toMatchObject({
      where: { OR: [{ metadataStatus: "PENDING" }, { metadataStatus: "FAILED", createdAt: { gt: weekAgo } }] },
    });
  });

  test("does nothing when nothing has failed", async () => {
    const queued: WorkItem[] = [];
    const result = await retryFailedMetadata({
      token: { findMany: pagedTable([]).findMany as never },
      collection: { findMany: pagedTable([]).findMany as never },
      enqueue: (item) => queued.push(item),
    });
    expect(result).toEqual({ tokens: 0, collections: 0 });
    expect(queued).toEqual([]);
  });
});
