import { describe, expect, mock, test } from "bun:test";
import { STARKNET_COLLECTION_721_CONTRACT } from "../config/constants.js";
import { normalizeAddress } from "./starknet.js";

const CONTRACT = normalizeAddress("STARKNET", "0xc0de");
const OWNER = normalizeAddress("STARKNET", "0xa11ce");

const row: { current: { collectionId: string | null; service: string } | null } = { current: null };
const getCollectionOwner = mock((..._args: unknown[]) => Promise.resolve(OWNER));

mock.module("../db/client.js", () => ({
  default: { collection: { findUnique: mock(() => Promise.resolve(row.current)) } },
}));
mock.module("../chainRead/index.js", () => ({ getCollectionOwner }));

async function ownerOf() {
  getCollectionOwner.mockClear();
  const { currentCollectionOwner } = await import("./collectionOwner.js");
  const owner = await currentCollectionOwner("STARKNET", CONTRACT);
  return { owner, args: getCollectionOwner.mock.calls[0] };
}

describe("currentCollectionOwner", () => {
  test("a collection held by the registry is read from the registry", async () => {
    row.current = { collectionId: "7", service: "mip-erc721" };
    const { owner, args } = await ownerOf();
    expect(owner).toBe(OWNER);
    expect(args?.[2]).toEqual({ address: STARKNET_COLLECTION_721_CONTRACT, collectionId: "7" });
  });

  test("a collection with its own owner view is read from the contract", async () => {
    row.current = { collectionId: null, service: "external-erc721" };
    expect((await ownerOf()).args?.[2]).toBeUndefined();
  });

  test("a collection that is not indexed is read from the contract", async () => {
    row.current = null;
    expect((await ownerOf()).args?.[2]).toBeUndefined();
  });
});
