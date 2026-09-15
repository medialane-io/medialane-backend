import { describe, expect, test } from "bun:test";
import { getCoordinates, getTokenBySymbol, normalizeAddress } from "@medialane/sdk";
import { blockNumberOf, emittingContracts, eventsFromReceipt, eventsFromTrackedContracts, polledContracts } from "./tx-sync.js";

describe("a receipt becomes the same input the poller applies", () => {
  test("each event carries the block and transaction it came from", () => {
    const events = eventsFromReceipt(
      { events: [{ from_address: "0xc", keys: ["0x1"], data: ["0x2"] }] },
      "0xtx",
      99,
    );
    expect(events).toEqual([
      { from_address: "0xc", keys: ["0x1"], data: ["0x2"], block_number: 99, transaction_hash: "0xtx" },
    ] as never);
  });

  test("an event with no address or no keys is not applied", () => {
    const events = eventsFromReceipt(
      { events: [{ keys: ["0x1"] }, { from_address: "0xc" }, { from_address: "0xc", keys: [] }] },
      "0xtx",
      1,
    );
    expect(events).toEqual([]);
  });

  test("a receipt carrying no events yields none", () => {
    expect(eventsFromReceipt({}, "0xtx", 1)).toEqual([]);
    expect(eventsFromReceipt(null, "0xtx", 1)).toEqual([]);
  });

  test("missing data defaults to empty rather than undefined", () => {
    const [event] = eventsFromReceipt({ events: [{ from_address: "0xc", keys: ["0x1"] }] }, "0xtx", 5);
    expect((event as unknown as { data: string[] }).data).toEqual([]);
  });
});

describe("a transaction still in the mempool is not applied", () => {
  test("a receipt with a block number reports it", () => {
    expect(blockNumberOf({ block_number: 42 })).toBe(42);
  });

  test("a receipt with no block number is not yet on chain", () => {
    expect(blockNumberOf({})).toBe(null);
    expect(blockNumberOf(null)).toBe(null);
    expect(blockNumberOf({ block_number: "42" })).toBe(null);
  });
});

describe("only contracts the indexer applies are synced", () => {
  const COLLECTION = "0x57b4f2390e6239194aa04608133e7d6652d31de318d3b7dfcd63db440579fc1";
  const STRK = getTokenBySymbol("STRK")!.address;

  const mintReceipt = {
    events: [
      { from_address: COLLECTION, keys: ["0x182d859c0807ba9db63baf8b9d9fdbfeb885d820be6e206b9dab626d995c433", "0x1", "0x0", "0x2"], data: ["0x3", "0x0", "0x1", "0x0"] },
      { from_address: COLLECTION, keys: ["0x10cc5308ddd5285", "0x3", "0x0", "0x2"], data: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6", "0x7", "0x8", "0x9"] },
      { from_address: "0x36a8f48641d42dba28375c31651aa14a4413582da2db7655a362a9e4ffc20d2", keys: ["0x1dcde06aabdbca2f80aa51392b345d7549d7757aa855f7e37f5d335ac8243b1", "0xabc"], data: [] },
      { from_address: STRK, keys: ["0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9", "0x1", "0x2"], data: ["0x10", "0x0"] },
    ],
  };

  test("a mint that also moves STRK syncs the collection's events and nothing else", () => {
    const events = eventsFromReceipt(mintReceipt, "0xtx", 14919581);
    const tracked = polledContracts();
    tracked.add(normalizeAddress("STARKNET", COLLECTION));

    const kept = eventsFromTrackedContracts(events, tracked);
    expect(kept).toHaveLength(2);
    expect(kept.every((e) => normalizeAddress("STARKNET", e.from_address) === normalizeAddress("STARKNET", COLLECTION))).toBe(true);
  });

  test("a token contract is never treated as a contract the indexer applies", () => {
    expect(polledContracts().has(normalizeAddress("STARKNET", STRK))).toBe(false);
  });

  test("the marketplaces and collection factories are applied", () => {
    const coords = getCoordinates("STARKNET");
    const tracked = polledContracts();
    for (const address of [coords.marketplace721, coords.marketplace1155, coords.collection721, coords.dataTokenization721]) {
      expect(tracked.has(normalizeAddress("STARKNET", address!))).toBe(true);
    }
  });

  test("each emitting contract is looked up once, in the stored address form", () => {
    const events = eventsFromReceipt(mintReceipt, "0xtx", 1);
    expect(emittingContracts(events)).toEqual([
      normalizeAddress("STARKNET", COLLECTION),
      normalizeAddress("STARKNET", "0x36a8f48641d42dba28375c31651aa14a4413582da2db7655a362a9e4ffc20d2"),
      normalizeAddress("STARKNET", STRK),
    ]);
  });
});
