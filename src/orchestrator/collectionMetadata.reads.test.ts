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

const unreachable = async (): Promise<string[]> => { throw new Error("fetch failed"); };
const refusal = async (): Promise<string[]> => { throw Object.assign(new Error("Entry point not found"), { code: 21 }); };
let callContract: (call: { entrypoint: string }) => Promise<string[]> = unreachable;
mock.module("../utils/starknet.js", () => ({
  ...actual,
  callRpc: (fn: (provider: unknown) => unknown) => fn({ callContract: (call: { entrypoint: string }) => callContract(call) }),
}));

const toHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") || "0"}`;
const text = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return ["0x0", toHex(bytes), `0x${bytes.length.toString(16)}`];
};
const answering = (answers: Record<string, string[]>) => async ({ entrypoint }: { entrypoint: string }) => {
  const answer = answers[entrypoint];
  if (!answer) return refusal();
  return answer;
};

const base = { metadataStatus: "PENDING", name: null, symbol: null, owner: null, image: null, attributes: null, baseUri: null, description: null };

beforeEach(() => {
  updates.length = 0;
  callContract = unreachable;
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
    callContract = refusal;
    const { detectTokenStandard } = await import("./collectionMetadata.js");
    expect(await detectTokenStandard("0xd")).toBeNull();
  });
});

describe("collection metadata sync outcomes", () => {
  test("a collection nobody indexed is skipped without a write", async () => {
    existing = null;
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0xe" });
    expect(updates).toEqual([]);
  });

  test("an own ERC1155 collection whose name and symbol cannot be read is marked failed without throwing", async () => {
    existing = { ...base, service: "mip-erc1155", standard: "ERC1155" };
    callContract = refusal;
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0xf" });
    expect(updates.map((u) => u.data)).toEqual([{ metadataStatus: "FAILED" }]);
  });

  test("an own ERC721 collection whose name and symbol cannot be read fails the job", async () => {
    existing = { ...base, service: "mip-erc721", standard: "ERC721" };
    callContract = refusal;
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await expect(handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0x10" })).rejects.toThrow("no legacy fallback");
    expect(updates.map((u) => u.data.metadataStatus)).toEqual(["FETCHING", "FAILED"]);
  });

  test("an already complete collection is left alone", async () => {
    existing = { ...base, service: "external-erc721", standard: "ERC721", metadataStatus: "FETCHED", owner: "0xabc" };
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0x11" });
    expect(updates).toEqual([]);
  });

  test("an external ERC1155 collection is saved with what the chain answers", async () => {
    existing = { ...base, service: "external-erc1155", standard: "ERC1155" };
    callContract = answering({ name: text("Gallery"), symbol: text("GAL"), owner: ["0xa11ce"] });
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0x12" });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data).toMatchObject({ standard: "ERC1155", metadataStatus: "FETCHED", name: "Gallery", symbol: "GAL", owner: expect.stringContaining("a11ce") });
  });

  test("an external ERC721 collection is saved with what the chain answers", async () => {
    existing = { ...base, service: "external-erc721", standard: "ERC721" };
    callContract = answering({ name: text("Pieces"), symbol: text("PCS"), owner: ["0xb0b"] });
    const { handleCollectionMetadataFetch } = await import("./collectionMetadata.js");
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: "0x13" });
    expect(updates.map((u) => u.data.metadataStatus)).toEqual(["FETCHING", "FETCHED"]);
    expect(updates[1]!.data).toMatchObject({ standard: "ERC721", name: "Pieces", symbol: "PCS", baseUri: null, owner: expect.stringContaining("b0b") });
  });
});
