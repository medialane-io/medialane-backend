import { describe, expect, test } from "bun:test";
import { getService } from "@medialane/sdk";
import { normalizeAddress } from "../../../utils/starknet.js";
import { encodeByteArray } from "../../../orchestrator/intent/shared.js";
import { dataTokenizationRegistry, registryMintCalls, royaltyBps } from "./mint-calls.js";

const OWNER = "0x0456";
const REGISTRY = "0x0789";

describe("registry mint calls", () => {
  test("the registry is the Data Tokenization factory from the service registry", () => {
    const factory = getService("data-tokenization-erc721")!.onchain!.STARKNET!.factoryAddress!;
    expect(dataTokenizationRegistry()).toBe(normalizeAddress("STARKNET", factory));
  });

  test("each token URI becomes one mint to the owner, with the royalty in basis points", async () => {
    const calls = await registryMintCalls(
      { isCollectionOwner: async () => true },
      { registry: REGISTRY, collectionId: "3", owner: OWNER, tokenUris: ["ipfs://a", "ipfs://b"], royaltyPercent: 5 },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      contractAddress: REGISTRY,
      entrypoint: "mint",
      calldata: ["3", "0", normalizeAddress("STARKNET", OWNER), ...encodeByteArray("ipfs://a"), "500"],
    });
    expect(calls[1]!.calldata).toContain(encodeByteArray("ipfs://b")[1]!);
  });

  test("the ownership check runs once for the whole batch", async () => {
    let checks = 0;
    await registryMintCalls(
      { isCollectionOwner: async () => (checks++, true) },
      { registry: REGISTRY, collectionId: "3", owner: OWNER, tokenUris: ["ipfs://a", "ipfs://b", "ipfs://c"], royaltyPercent: 0 },
    );
    expect(checks).toBe(1);
  });

  test("someone who does not own the collection gets no calls", async () => {
    await expect(
      registryMintCalls(
        { isCollectionOwner: async () => false },
        { registry: REGISTRY, collectionId: "3", owner: OWNER, tokenUris: ["ipfs://a"], royaltyPercent: 0 },
      ),
    ).rejects.toThrow();
  });

  test("fractional royalty percentages round to whole basis points", () => {
    expect(royaltyBps(2.5)).toBe(250);
    expect(royaltyBps(0.015)).toBe(2);
  });
});
