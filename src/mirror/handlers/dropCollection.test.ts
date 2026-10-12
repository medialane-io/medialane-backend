import { describe, expect, test } from "bun:test";
import { hash } from "starknet";
import { normalizeAddress } from "@medialane/sdk";
import { catchUpDropEvents, dropEventLogIndexes, parseDropCollectionEvent } from "./dropCollection.js";
import { DROP_COLLECTION_SELECTORS } from "../../config/constants.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const DROP = normalizeAddress("STARKNET", "0xd409");
const OTHER = normalizeAddress("STARKNET", "0xd410");
const WALLET = normalizeAddress("STARKNET", "0x222");
const sel = (n: string) => hash.getSelectorFromName(n);
const ev = (over: Partial<RawStarknetEvent>): RawStarknetEvent =>
  ({ block_hash: "0xb", block_number: 100, transaction_hash: "0x1", from_address: DROP, keys: [], data: [], ...over });

describe("drop collection events", () => {
  test("Claimed is a claim: wallet, quantity, first token, total paid", () => {
    const e = ev({ keys: [sel("Claimed"), "0x222"], data: ["0x3", "0x0", "0xb", "0x0", "0xe4e1c0", "0x0"] });
    expect(parseDropCollectionEvent(e)).toEqual({
      type: "mint", kind: "CLAIM", collectionAddress: DROP, wallet: WALLET, quantity: "3", firstTokenId: "11", totalPaid: "15000000",
    });
  });

  test("Issued is a gift with nothing paid", () => {
    const e = ev({ keys: [sel("Issued"), "0x222"], data: ["0x2", "0x0", "0x1", "0x0"] });
    expect(parseDropCollectionEvent(e)).toEqual({
      type: "mint", kind: "ISSUE", collectionAddress: DROP, wallet: WALLET, quantity: "2", firstTokenId: "1", totalPaid: "0",
    });
  });

  test("AllowlistRootSet carries the new root", () => {
    expect(parseDropCollectionEvent(ev({ keys: [sel("AllowlistRootSet")], data: ["0xabc"] })))
      .toEqual({ type: "root", collectionAddress: DROP, root: "0xabc" });
  });

  test("other events are ignored", () => {
    expect(parseDropCollectionEvent(ev({ keys: [sel("Transfer"), "0x0", "0x222", "0x1", "0x0"] }))).toBeNull();
  });

  test("log indexes count per transaction and per drop, in order", () => {
    const events = [
      ev({ transaction_hash: "0x1", from_address: DROP }),
      ev({ transaction_hash: "0x1", from_address: OTHER }),
      ev({ transaction_hash: "0x1", from_address: DROP }),
      ev({ transaction_hash: "0x2", from_address: DROP }),
    ];
    expect(dropEventLogIndexes(events)).toEqual([0, 0, 1, 0]);
    // The same drop's events polled on their own get the same indexes.
    expect(dropEventLogIndexes([events[0]!, events[2]!])).toEqual([0, 1]);
  });

  test("catch-up reads the drop's own events from its creation block to the latest block", async () => {
    const seen: unknown[] = [];
    const applied: RawStarknetEvent[][] = [];
    const one = ev({ keys: [sel("Claimed"), "0x222"], data: ["0x1", "0x0", "0x1", "0x0", "0x0", "0x0"] });
    await catchUpDropEvents(DROP, 16240900, {
      latest: async () => 16250000,
      poll: async (p) => { seen.push(p); return [one]; },
      apply: async (events) => { applied.push(events); },
    });
    expect(seen).toEqual([{ address: DROP, fromBlock: 16240900, toBlock: 16250000, keys: [DROP_COLLECTION_SELECTORS.map((s) => "0x" + BigInt(s).toString(16))] }]);
    expect(applied).toEqual([[one]]);
  });
});
