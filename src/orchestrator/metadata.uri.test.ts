import { afterAll, expect, mock, test } from "bun:test";

const actual = await import("../utils/starknet.js");
afterAll(() => mock.module("../utils/starknet.js", () => actual));

const updates: unknown[] = [];

mock.module("../db/client.js", () => ({
  default: {
    token: { updateMany: mock(async (arg: unknown) => { updates.push(arg); return { count: 1 }; }) },
    collection: { findUnique: mock(async () => ({ standard: "ERC721", service: "mip-erc721" })) },
  },
}));
mock.module("../utils/starknet.js", () => ({
  ...actual,
  callRpc: mock(async () => { throw Object.assign(new Error("Entry point not found"), { code: 21 }); }),
}));

test("a token whose tokenURI is not readable yet fails the job so the worker retries it", async () => {
  const { handleMetadataFetch } = await import("./metadata.js");
  await expect(handleMetadataFetch({ chain: "STARKNET", contractAddress: "0xc", tokenId: "1" })).rejects.toThrow("No tokenURI found");
  expect(updates.at(-1)).toMatchObject({ data: { metadataStatus: "FAILED" } });
});
