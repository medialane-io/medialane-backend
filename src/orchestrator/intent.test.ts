// Sanity tests for the SDK SNIP-12 builders that the backend depends on.
//
// Guards against the incident class where the backend signs the wrong protocol
// version/shape: signatures the Cairo contracts reject, so marketplace orders
// silently fail. Cheap to verify; catastrophic to miss. Updated for the
// redesigned venues (domain v4 / v3, single-amount schema, unsigned fulfil).
import { describe, expect, test } from "bun:test";
import {
  buildOrderTypedData,
  build1155OrderTypedData,
  buildCancellationTypedData,
  build1155CancellationTypedData,
} from "@medialane/sdk/starknet";

const CHAIN_ID = "SN_MAIN";
const names = (defs: readonly { name: string }[]) => defs.map((f) => f.name);

describe("ERC-721 SNIP-12 builders use domain version 5 (2026-06-26 redeploy)", () => {
  test("buildOrderTypedData", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.name).toBe("Medialane");
    expect(td.domain.version).toBe("5");
    expect(td.primaryType).toBe("OrderParameters");
    expect(td.types.OrderParameters).toBeDefined();
    expect(td.types.OfferItem).toBeDefined();
    expect(td.types.ConsiderationItem).toBeDefined();
  });

  test("OrderParameters carries the redesigned fields in order", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(names(td.types.OrderParameters as { name: string }[])).toEqual([
      "offerer", "marketplace", "offer", "consideration",
      "royalty_max_bps", "start_time", "end_time", "salt", "counter",
    ]);
    expect(names(td.types.OfferItem as { name: string }[])).toEqual([
      "item_type", "token", "identifier_or_criteria", "amount",
    ]);
  });

  test("buildCancellationTypedData has no nonce", () => {
    const td = buildCancellationTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("5");
    expect(td.primaryType).toBe("OrderCancellation");
    expect(names(td.types.OrderCancellation as { name: string }[])).toEqual([
      "order_hash", "offerer",
    ]);
  });
});

describe("ERC-1155 SNIP-12 builders use domain version 4 (2026-06-26 redeploy)", () => {
  test("build1155OrderTypedData", () => {
    const td = build1155OrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.name).toBe("Medialane");
    expect(td.domain.version).toBe("4");
    expect(td.primaryType).toBe("OrderParameters");
  });

  test("build1155CancellationTypedData", () => {
    const td = build1155CancellationTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("4");
    expect(td.primaryType).toBe("OrderCancellation");
  });
});

describe("Cross-standard sanity", () => {
  test("721 and 1155 order builders use different domain versions", () => {
    const v721 = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    const v1155 = build1155OrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(v721.domain.version).not.toBe(v1155.domain.version);
  });

  test("chainId is propagated into the domain", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.chainId).toBe(CHAIN_ID);
  });
});
