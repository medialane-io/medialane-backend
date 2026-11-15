import { describe, expect, mock, test } from "bun:test";
import * as realStarknet from "../utils/starknet.js";

const OWNER = realStarknet.normalizeAddress("STARKNET", "0xa11ce");
const IP_NFT = realStarknet.normalizeAddress("STARKNET", "0x1f7");
const REGISTRY = realStarknet.normalizeAddress("STARKNET", "0x4e6");

const callContract = mock((..._args: unknown[]) =>
  Promise.resolve(["0x0", "0x6e", "0x0", "0x0", "0x73", "0x0", "0x0", "0x62", "0x0", OWNER, IP_NFT]),
);
mock.module("../utils/starknet.js", () => ({
  ...realStarknet,
  callRpc: (fn: (p: unknown) => unknown) => fn({ callContract }),
}));

describe("the owner of a registry collection", () => {
  test("is the value before the collection contract in what the registry returns", async () => {
    const { starknetAdapter } = await import("./starknet.js");
    const owner = await starknetAdapter.collectionOwner(IP_NFT, { address: REGISTRY, collectionId: "7" });
    expect(owner).toBe(OWNER);
    expect(callContract.mock.calls[0]?.[0]).toMatchObject({ contractAddress: REGISTRY, entrypoint: "get_collection", calldata: ["7", "0"] });
  });
});
