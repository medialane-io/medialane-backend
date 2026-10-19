import { expect, mock, test } from "bun:test";

const updates: unknown[] = [];

mock.module("../db/client.js", () => ({
  default: {
    token: { updateMany: mock(async (arg: unknown) => { updates.push(arg); return { count: 1 }; }) },
    collection: { findUnique: mock(async () => ({ standard: "ERC721", service: "mip-erc721" })) },
  },
}));
mock.module("../utils/starknet.js", () => ({ callRpc: mock(async () => null) }));

test("a token whose tokenURI is not readable yet fails the job so the worker retries it", async () => {
  const { handleMetadataFetch } = await import("./metadata.js");
  await expect(handleMetadataFetch({ chain: "STARKNET", contractAddress: "0xc", tokenId: "1" })).rejects.toThrow("No tokenURI found");
  expect(updates.at(-1)).toMatchObject({ data: { metadataStatus: "FAILED" } });
});
