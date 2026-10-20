import { describe, expect, test, mock } from "bun:test";
import { batchOrdersByToken, batchFallbackImages, serializeCollection, serializeCollections, serializeCreatorProfile, serializeToken } from "./serialize.js";

describe("batchOrdersByToken", () => {
  test("groups active orders by contractAddress:tokenId, one query for all tokens", async () => {
    const findMany = mock(async () => [
      { id: "o1", chain: "STARKNET", nftContract: "0xabc", nftTokenId: "1", status: "ACTIVE" },
      { id: "o2", chain: "STARKNET", nftContract: "0xabc", nftTokenId: "1", status: "ACTIVE" },
      { id: "o3", chain: "STARKNET", nftContract: "0xdef", nftTokenId: "2", status: "ACTIVE" },
    ]);
    const result = await batchOrdersByToken(
      [
        { chain: "STARKNET", contractAddress: "0xabc", tokenId: "1" },
        { chain: "STARKNET", contractAddress: "0xdef", tokenId: "2" },
      ],
      { order: { findMany } } as any,
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result.get("0xabc:1")).toHaveLength(2);
    expect(result.get("0xdef:2")).toHaveLength(1);
    expect(result.get("0xnotfound:9")).toBeUndefined();
  });

  test("returns an empty Map for an empty token list without querying", async () => {
    const findMany = mock(async () => []);
    const result = await batchOrdersByToken([], { order: { findMany } } as any);
    expect(findMany).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

describe("serializeCreatorProfile", () => {
  test("shapes a profile + wallet address into the public creator response, including timestamps", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-02-01T00:00:00.000Z");
    const result = serializeCreatorProfile(
      {
        username: "alice",
        name: "Alice",
        bio: "hi",
        avatarImage: null,
        websiteUrl: null,
        twitterUrl: null,
        discordUrl: null,
        telegramUrl: null,
        createdAt,
        updatedAt,
      },
      "0xwallet",
    );
    expect(result).toEqual({
      walletAddress: "0xwallet",
      username: "alice",
      name: "Alice",
      bio: "hi",
      avatarImage: null,
      websiteUrl: null,
      twitterUrl: null,
      discordUrl: null,
      telegramUrl: null,
      createdAt,
      updatedAt,
    });
  });
});

describe("collection image fallback", () => {
  const collection = {
    id: "c1", chain: "STARKNET", contractAddress: "0xabc", collectionId: null, name: "C", symbol: "C",
    description: null, image: null, owner: null, startBlock: 1n, metadataStatus: "FETCHED", standard: "ERC721",
    isFeatured: false, isHidden: false, service: "external-erc721", claimedBy: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  } as never;

  test("shows the first token's image only when the collection has none, and never its description", () => {
    expect(serializeCollection(collection, undefined, "ipfs://token")).toMatchObject({ image: "ipfs://token", description: null });
    expect(serializeCollection({ ...(collection as object), image: "ipfs://own" } as never, undefined, "ipfs://token").image).toBe("ipfs://own");
    expect(serializeCollection(collection, undefined).image).toBeNull();
  });

  test("looks up first-token images in one query, only for collections without an image", async () => {
    const queryRaw = mock(async () => [{ contractAddress: "0xabc", image: "ipfs://token" }]);
    const images = await batchFallbackImages(
      [{ chain: "STARKNET", contractAddress: "0xabc", image: null }, { chain: "STARKNET", contractAddress: "0xdef", image: "ipfs://own" }] as never,
      { $queryRaw: queryRaw as never },
    );
    expect(images.get("0xabc")).toBe("ipfs://token");
    expect(images.has("0xdef")).toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  test("a list of collections gets each one's fallback, not its position in the list", async () => {
    const queryRaw = mock(async () => [{ contractAddress: "0xabc", image: "ipfs://token" }]);
    const rows = [collection, { ...(collection as object), contractAddress: "0xnone" }] as never[];
    const data = await serializeCollections(rows, { $queryRaw: queryRaw as never });
    expect(data.map((d) => d.image)).toEqual(["ipfs://token", null]);
  });

  test("skips the query when every collection has its own image", async () => {
    const queryRaw = mock(async () => []);
    await batchFallbackImages([{ chain: "STARKNET", contractAddress: "0xdef", image: "ipfs://own" }] as never, { $queryRaw: queryRaw as never });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("collection attributes", () => {
  const collection = {
    id: "c1", chain: "STARKNET", contractAddress: "0xabc", collectionId: null, name: "Gala", symbol: "GALA",
    description: null, image: null, owner: null, startBlock: 1n, metadataStatus: "FETCHED", standard: "ERC721",
    isFeatured: false, isHidden: false, service: "pop-protocol", claimedBy: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  };

  test("are returned as indexed from the collection metadata", () => {
    const attributes = [{ trait_type: "Visibility", value: "Private" }];
    expect(serializeCollection({ ...collection, attributes } as never, undefined).attributes).toEqual(attributes);
  });

  test("are null when none were indexed", () => {
    expect(serializeCollection({ ...collection, attributes: null } as never, undefined).attributes).toBeNull();
  });
});

describe("a token's description", () => {
  const token = {
    id: "t1", chain: "STARKNET", contractAddress: "0xc", tokenId: "1", tokenUri: null, metadataStatus: "FETCHED",
    name: "One", image: null, animationUrl: null, attributes: null, ipType: null, licenseType: null,
    commercialUse: null, author: null, isHidden: false, createdAt: new Date(0), updatedAt: new Date(0),
    collection: { standard: "ERC721" },
  } as any;

  test("is the one read from the token's metadata", () => {
    expect(serializeToken(token, [], undefined, "About this token").metadata.description).toBe("About this token");
  });

  test("is empty in lists, where none is read", () => {
    expect(serializeToken(token, []).metadata.description).toBeNull();
  });
});
