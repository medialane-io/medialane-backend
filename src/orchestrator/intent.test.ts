// Sanity tests for the SDK SNIP-12 builders that backend depends on after R1.
//
// These guard against the 2026-04-28 incident class: backend signing the
// wrong protocol version (V1 ERC-721 domain vs V2 ERC-1155 domain) would
// produce signatures the Cairo contracts reject, so marketplace orders
// silently fail. Cheap to verify; catastrophic to miss.
import { describe, expect, test } from "bun:test";
import {
  buildOrderTypedData,
  build1155OrderTypedData,
  buildFulfillmentTypedData,
  build1155FulfillmentTypedData,
  buildCancellationTypedData,
  build1155CancellationTypedData,
} from "@medialane/sdk";

const CHAIN_ID = "SN_MAIN";

describe("ERC-721 SNIP-12 builders use domain version 1", () => {
  test("buildOrderTypedData", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.name).toBe("Medialane");
    expect(td.domain.version).toBe("1");
    expect(td.primaryType).toBe("OrderParameters");
    expect(td.types.OrderParameters).toBeDefined();
    expect(td.types.OfferItem).toBeDefined();
    expect(td.types.ConsiderationItem).toBeDefined();
  });

  test("buildFulfillmentTypedData — no quantity field", () => {
    const td = buildFulfillmentTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("1");
    expect(td.primaryType).toBe("OrderFulfillment");
    const fields = td.types.OrderFulfillment.map((f) => f.name);
    expect(fields).toEqual(["order_hash", "fulfiller", "nonce"]);
  });

  test("buildCancellationTypedData", () => {
    const td = buildCancellationTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("1");
    expect(td.primaryType).toBe("OrderCancellation");
  });
});

describe("ERC-1155 SNIP-12 builders use domain version 2", () => {
  test("build1155OrderTypedData", () => {
    const td = build1155OrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.name).toBe("Medialane");
    expect(td.domain.version).toBe("2");
    expect(td.primaryType).toBe("OrderParameters");
  });

  test("build1155FulfillmentTypedData — includes quantity field", () => {
    const td = build1155FulfillmentTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("2");
    const fields = td.types.OrderFulfillment.map((f) => f.name);
    expect(fields).toEqual(["order_hash", "fulfiller", "quantity", "nonce"]);
  });

  test("build1155CancellationTypedData", () => {
    const td = build1155CancellationTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("2");
    expect(td.primaryType).toBe("OrderCancellation");
  });
});

describe("Cross-standard sanity", () => {
  test("ERC-721 and ERC-1155 order builders use different domain versions", () => {
    const v1 = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    const v2 = build1155OrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(v1.domain.version).not.toBe(v2.domain.version);
  });

  test("chainId is propagated into the domain", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.chainId).toBe(CHAIN_ID);
  });
});
