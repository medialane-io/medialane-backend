import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { RPC_UNAVAILABLE } from "../utils/rpcFailover.js";

const actual = await import("../utils/starknet.js");
afterAll(() => mock.module("../utils/starknet.js", () => actual));

const statuses: unknown[] = [];
mock.module("../db/client.js", () => ({
  default: {
    collection: { findUnique: mock(async () => ({ standard: "ERC721", service: "mip-erc721" })) },
    token: { updateMany: mock(async (arg: { data: { metadataStatus?: unknown } }) => { statuses.push(arg.data.metadataStatus); return { count: 1 }; }) },
  },
}));

let callContract: () => Promise<string[]> = async () => { throw new Error(RPC_UNAVAILABLE); };
mock.module("../utils/starknet.js", () => ({
  ...actual,
  callRpc: (fn: (provider: unknown) => unknown) => fn({ callContract: () => callContract() }),
}));

beforeEach(() => { statuses.length = 0; });

describe("a token's metadata status after a fetch that could not finish", () => {
  test("a token read while every RPC endpoint is unavailable stays pending", async () => {
    callContract = async () => { throw new Error(RPC_UNAVAILABLE); };
    const { handleMetadataFetch } = await import("./metadata.js");
    await expect(handleMetadataFetch({ chain: "STARKNET", contractAddress: "0xc", tokenId: "1" })).rejects.toThrow(RPC_UNAVAILABLE);
    expect(statuses).toEqual(["FETCHING", "PENDING"]);
  });

  test("a token whose contract gives no token URI is failed", async () => {
    callContract = async () => { throw Object.assign(new Error("Entry point not found"), { code: 21 }); };
    const { handleMetadataFetch } = await import("./metadata.js");
    await expect(handleMetadataFetch({ chain: "STARKNET", contractAddress: "0xc", tokenId: "2" })).rejects.toThrow("No tokenURI found");
    expect(statuses).toEqual(["FETCHING", "FAILED"]);
  });
});
