import { describe, expect, test } from "bun:test";
import { decodeStellarEvents, type StellarRawEvent } from "./decode.js";

const V = "CVENUE000000000000000000000000000000000000000000000000A";
const R = "CREGISTRY0000000000000000000000000000000000000000000000B";
const G = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const raw = (partial: Partial<StellarRawEvent>): StellarRawEvent => ({
  contractId: V, ledger: 10, txHash: "abc", topic: [], value: {}, ...partial,
});

describe("decodeStellarEvents", () => {
  test("venue order lifecycle", () => {
    const events = decodeStellarEvents(
      [
        raw({ topic: [{ symbol: "created" }, { address: G }], value: { u64: "42" } }),
        raw({ topic: [{ symbol: "filled" }, { address: G }, { address: G }], value: { vec: [{ u64: "42" }, { i128: { lo: "1000" } }] } }),
        raw({ topic: [{ symbol: "cancelled" }, { address: G }], value: { u64: "43" } }),
      ],
      new Set([R]),
    );
    expect(events.map((e) => e.kind)).toEqual(["OrderCreated", "OrderFulfilled", "OrderCancelled"]);
    expect(events[1]).toMatchObject({ salt: 42n, saleAmount: 1000n, fulfiller: G });
  });
  test("registry created is distinguished by contract id", () => {
    const [e] = decodeStellarEvents(
      [raw({ contractId: R, topic: [{ symbol: "created" }, { u64: "3" }], value: { vec: [{ address: V }, { address: G }, { string: "My IP" }] } })],
      new Set([R]),
    );
    expect(e).toMatchObject({ kind: "CollectionCreated", collectionId: 3n, collection: V, creator: G, name: "My IP" });
  });
  test("noise skipped", () => {
    expect(decodeStellarEvents([raw({ topic: [{ symbol: "other" }] })], new Set())).toEqual([]);
  });
});
