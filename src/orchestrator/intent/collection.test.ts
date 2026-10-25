import { describe, expect, mock, test } from "bun:test";
import { normalizeAddress } from "@medialane/sdk";
import { CallData, byteArray } from "starknet";

const felts = (xs: unknown) => (xs as string[]).map((x) => BigInt(x));
const encoded = (s: string) => felts(CallData.compile([byteArray.byteArrayFromString(s)]));

mock.module("../../utils/collection.js", () => ({
  resolveServiceForContract: async (_db: unknown, _chain: string, _contractAddress: string) => "pop-protocol",
}));

const pinned: unknown[] = [];
mock.module("../metadataPin.js", () => ({
  uploadJson: async (metadata: unknown) => (pinned.push(metadata), "ipfs://pinned"),
}));

const { buildMintIntent, buildCreateCollectionIntent } = await import("./collection.js");

describe("buildCreateCollectionIntent without a base URI", () => {
  test("pins the standard collection metadata, linking to the owner's account page", async () => {
    pinned.length = 0;
    await buildCreateCollectionIntent({ owner: "0x0123", name: "Club", symbol: "CLB", description: "d", service: "pop-protocol" } as never);
    expect(pinned).toEqual([
      { name: "Club", description: "d", external_link: `https://www.medialane.io/account/${normalizeAddress("STARKNET", "0x0123")}` },
    ]);
  });
});

describe("buildMintIntent for a pop-protocol collection", () => {
  test("calls issue with an empty token URI by default", async () => {
    const result = await buildMintIntent({
      owner: "0x01",
      recipient: "0x02",
      collectionContract: "0x03",
    } as never);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("issue");
    expect(result.calls[0].contractAddress).toBe(normalizeAddress("STARKNET", "0x03"));
    expect(felts(result.calls[0].calldata)).toEqual([0x02n, ...encoded("")]);
  });

  test("passes a token URI through when one is given", async () => {
    const result = await buildMintIntent({
      owner: "0x01",
      recipient: "0x02",
      collectionContract: "0x03",
      customUri: "ipfs://distinction",
    } as never);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("issue");
    expect(felts(result.calls[0].calldata)).toEqual([0x02n, ...encoded("ipfs://distinction")]);
  });
});
