import { describe, expect, test } from "bun:test";
import { eventsFromReceipt, blockNumberOf } from "./tx-sync.js";

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
