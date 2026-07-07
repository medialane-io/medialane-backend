import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { EvmMipRegistryABI, EvmVenueABI } from "@medialane/sdk/evm";
import { decodeEvmLogs } from "./decode.js";

function synthetic(partial: { address: `0x${string}`; topics: unknown; data: `0x${string}` }): Log {
  return {
    address: partial.address,
    topics: partial.topics as Log["topics"],
    data: partial.data,
    blockNumber: 100n,
    transactionHash: "0x" + "ab".repeat(32) as `0x${string}`,
    logIndex: 3,
    blockHash: "0x" + "cd".repeat(32) as `0x${string}`,
    transactionIndex: 0,
    removed: false,
  };
}

describe("decodeEvmLogs", () => {
  test("decodes CollectionCreated into the protocol vocabulary", () => {
    const encoded = {
      topics: encodeEventTopics({
        abi: EvmMipRegistryABI,
        eventName: "CollectionCreated",
        args: {
          collectionId: 1n,
          collection: "0x1000000000000000000000000000000000000001",
          creator: "0x2000000000000000000000000000000000000002",
        },
      }),
      data: encodeAbiParameters(
        [{ type: "string" }, { type: "string" }, { type: "string" }],
        ["My IP", "MIP", "ipfs://base/"],
      ),
    };
    const [event] = decodeEvmLogs([
      synthetic({ address: "0x3000000000000000000000000000000000000003", ...encoded }),
    ]);
    expect(event).toMatchObject({
      kind: "CollectionCreated",
      collection: "0x1000000000000000000000000000000000000001",
      creator: "0x2000000000000000000000000000000000000002",
      registry: "0x3000000000000000000000000000000000000003",
      name: "My IP",
      blockNumber: 100n,
      logIndex: 3,
    });
  });

  test("decodes order lifecycle events", () => {
    const orderHash = ("0x" + "11".repeat(32)) as `0x${string}`;
    const offerer = "0x2000000000000000000000000000000000000002" as const;
    const created = {
      topics: encodeEventTopics({ abi: EvmVenueABI, eventName: "OrderCreated", args: { orderHash, offerer } }),
      data: "0x" as const,
    };
    const fulfilled = {
      topics: encodeEventTopics({
        abi: EvmVenueABI,
        eventName: "OrderFulfilled",
        args: { orderHash, offerer, fulfiller: "0x4000000000000000000000000000000000000004" },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
        [10n ** 18n, "0x0000000000000000000000000000000000000000", 0n],
      ),
    };
    const venue = "0x5000000000000000000000000000000000000005" as const;
    const events = decodeEvmLogs([
      synthetic({ address: venue, ...created }),
      synthetic({ address: venue, ...fulfilled }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["OrderCreated", "OrderFulfilled"]);
    expect(events[1]).toMatchObject({ orderHash, fulfiller: "0x4000000000000000000000000000000000000004", saleAmount: 10n ** 18n });
  });

  test("unknown logs are skipped", () => {
    expect(decodeEvmLogs([synthetic({ address: "0x1000000000000000000000000000000000000001", topics: ["0x" + "ff".repeat(32)], data: "0x" })])).toEqual([]);
  });
});
