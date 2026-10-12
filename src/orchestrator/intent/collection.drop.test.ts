import { describe, expect, mock, test } from "bun:test";
import { getTokenBySymbol, STARKNET_DROP_FACTORY_CONTRACT } from "@medialane/sdk";
import { dropCalls } from "@medialane/sdk/starknet";

mock.module("../metadataPin.js", () => ({
  uploadJson: async () => { throw new Error("a drop must not upload collection metadata"); },
}));

const { buildCreateCollectionIntent } = await import("./collection.js");

const USDC = getTokenBySymbol("USDC")!.address;
const OWNER = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
const terms = { startTime: 0, endTime: 0, price: "5000000", paymentToken: USDC, maxPerWallet: "5" };
const body = (over: Record<string, unknown> = {}) =>
  ({ owner: OWNER, name: "Neon Tides", symbol: "NEON", baseUri: "ipfs://cid/", service: "drop-collection", maxSupply: "500", terms, ...over }) as never;

describe("drop creation intent", () => {
  test("is the SDK's create_drop call, allowlist root included", async () => {
    const { calls } = await buildCreateCollectionIntent(body({ allowlistRoot: "0xabc" }));
    const expected = dropCalls.create(STARKNET_DROP_FACTORY_CONTRACT, {
      name: "Neon Tides", symbol: "NEON", baseUri: "ipfs://cid/", maxSupply: "500", terms, allowlistRoot: "0xabc",
    });
    expect(calls).toEqual([
      { contractAddress: expected.contractAddress, entrypoint: "create_drop", calldata: (expected.calldata as string[]).map(String) },
    ]);
  });

  test("a free drop naming a token is sent with a zero token", async () => {
    const free = { ...terms, price: "0", paymentToken: "0x999" };
    const { calls } = await buildCreateCollectionIntent(body({ terms: free }));
    const expected = dropCalls.create(STARKNET_DROP_FACTORY_CONTRACT, {
      name: "Neon Tides", symbol: "NEON", baseUri: "ipfs://cid/", maxSupply: "500", terms: free,
    });
    expect(calls[0]!.calldata).toEqual((expected.calldata as string[]).map(String));
  });

  test("refuses a drop without a metadata folder, before uploading anything", async () => {
    await expect(buildCreateCollectionIntent(body({ baseUri: "" }))).rejects.toThrow("baseUri is required for a drop");
  });

  test("refuses a drop without supply or terms", async () => {
    await expect(buildCreateCollectionIntent(body({ maxSupply: undefined }))).rejects.toThrow("maxSupply and terms are required for a drop");
    await expect(buildCreateCollectionIntent(body({ terms: undefined }))).rejects.toThrow("maxSupply and terms are required for a drop");
  });

  test("refuses a sale that ends at or before its start", async () => {
    await expect(buildCreateCollectionIntent(body({ terms: { ...terms, startTime: 100, endTime: 100 } }))).rejects.toThrow("The sale must end after it starts");
  });

  test("refuses a paid drop in an unlisted token", async () => {
    await expect(buildCreateCollectionIntent(body({ terms: { ...terms, paymentToken: "0x999" } }))).rejects.toThrow("Unknown payment token");
  });
});
