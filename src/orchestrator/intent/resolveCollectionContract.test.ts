import { test, expect } from "bun:test";
import { resolveCollectionContract } from "./shared.js";
import { getService } from "@medialane/sdk";
import { normalizeAddress } from "../../utils/starknet.js";

const DATA_FACTORY = getService("data-tokenization-erc721")!.onchain!.STARKNET!.factoryAddress!;
const IP_COLLECTION_FACTORY = getService("mip-erc721")!.onchain!.STARKNET!.factoryAddress!;

test("Data Tokenization resolves to its own factory", () => {
  expect(resolveCollectionContract(undefined, "data-tokenization-erc721")).toBe(
    normalizeAddress("STARKNET", DATA_FACTORY),
  );
});

test("IP Collection resolves to its own factory", () => {
  expect(resolveCollectionContract(undefined, "mip-erc721")).toBe(
    normalizeAddress("STARKNET", IP_COLLECTION_FACTORY),
  );
});

test("the two services never resolve to the same contract", () => {
  expect(resolveCollectionContract(undefined, "data-tokenization-erc721")).not.toBe(
    resolveCollectionContract(undefined, "mip-erc721"),
  );
});

test("an explicit override always wins", () => {
  expect(resolveCollectionContract("0x99", "data-tokenization-erc721")).toBe(
    normalizeAddress("STARKNET", "0x99"),
  );
});

test("a service with no factory falls back to the shared contract", () => {
  expect(resolveCollectionContract(undefined, "ip-erc721")).toBe(resolveCollectionContract());
});

test("no service given keeps the previous behaviour", () => {
  expect(resolveCollectionContract()).toBe(resolveCollectionContract(undefined, null));
});
