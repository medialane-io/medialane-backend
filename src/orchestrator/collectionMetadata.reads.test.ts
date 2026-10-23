import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const actual = await import("../utils/starknet.js");
afterAll(() => mock.module("../utils/starknet.js", () => actual));

const updates: Array<{ data: Record<string, unknown> }> = [];
let existing: Record<string, unknown> | null = null;

mock.module("../db/client.js", () => ({
  default: {
    collection: {
      findUnique: mock(async () => existing),
      update: mock(async (arg: { data: Record<string, unknown> }) => { updates.push(arg); return {}; }),
    },
    transactionIntent: { findFirst: mock(async () => null) },
  },
}));

let rpc: () => Promise<unknown> = async () => { throw new Error("fetch failed"); };
mock.module("../utils/starknet.js", () => ({ ...actual, callRpc: () => rpc() }));

const base = { metadataStatus: "PENDING", name: null, symbol: null, owner: null, image: null, attributes: null, baseUri: null, description: null };

beforeEach(() => {
  updates.length = 0;
  rpc = async () => { throw new Error("fetch failed"); };
});

describe("collection reads when the node cannot be reached", () => {
  test("an external ERC721 collection is marked failed so it is retried", async () => {
    existing = { ...base, service: "external-erc721", standard: "ERC721" };
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await expect(handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0xa" })).rejects.toThrow("fetch failed");
    expect(updates.map((u) => u.data.metadataStatus)).toContain("FAILED");
    expect(updates.map((u) => u.data.metadataStatus)).not.toContain("FETCHED");
  });

  test("an external ERC1155 collection is marked failed instead of saved empty", async () => {
    existing = { ...base, service: "external-erc1155", standard: "ERC1155" };
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await expect(handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0xb" })).rejects.toThrow("fetch failed");
    expect(updates.map((u) => u.data.metadataStatus)).toEqual(["FAILED"]);
  });

  test("the token standard is not guessed: the failure reaches the caller", async () => {
    const { detectTokenStandard } = await import("./collectionMetadata.js");
    await expect(detectTokenStandard("0xc")).rejects.toThrow("fetch failed");
  });

  test("a contract that refuses every probe is still not a collection", async () => {
    rpc = async () => { throw Object.assign(new Error("Entry point not found"), { code: 21 }); };
    const { detectTokenStandard } = await import("./collectionMetadata.js");
    expect(await detectTokenStandard("0xd")).toBeNull();
  });
});
