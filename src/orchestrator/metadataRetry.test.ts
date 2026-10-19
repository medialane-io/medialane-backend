import { describe, expect, mock, test } from "bun:test";
import type { WorkItem } from "./worker.js";

mock.module("../db/client.js", () => ({ default: {} }));

const { retryFailedMetadata, startMetadataRetryLoop } = await import("./metadataRetry.js");

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

  test("re-queues tokens still waiting for metadata as well as failed ones", async () => {
    const tokenTable = pagedTable(tokens(1));
    await retryFailedMetadata({
      token: { findMany: tokenTable.findMany as never },
      collection: { findMany: pagedTable([]).findMany as never },
      enqueue: () => {},
    });
    expect(tokenTable.calls[0]).toMatchObject({ where: { metadataStatus: { in: ["PENDING", "FAILED"] } } });
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

describe("startMetadataRetryLoop", () => {
  test("runs a pass as soon as it starts, then waits between passes", async () => {
    const order: string[] = [];
    const stop = new Error("stop");
    let waits = 0;
    await startMetadataRetryLoop({
      pass: async () => void order.push("pass"),
      wait: async () => {
        order.push("wait");
        if (++waits === 2) throw stop;
      },
    }).catch((e) => expect(e).toBe(stop));
    expect(order).toEqual(["pass", "wait", "pass", "wait"]);
  });

  test("keeps going after a pass fails", async () => {
    const order: string[] = [];
    const stop = new Error("stop");
    await startMetadataRetryLoop({
      pass: async () => {
        order.push("pass");
        throw new Error("db down");
      },
      wait: async () => {
        order.push("wait");
        throw stop;
      },
    }).catch((e) => expect(e).toBe(stop));
    expect(order).toEqual(["pass", "wait"]);
  });
});
