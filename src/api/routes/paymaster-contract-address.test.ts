import { describe, expect, test } from "bun:test";
import { getCoordinates, normalizeAddress, SUPPORTED_TOKENS } from "@medialane/sdk";
import { createContractAddressChecker } from "./paymaster-contract-address.js";

const coords = getCoordinates("STARKNET");

function fakeDb(collections: Record<string, string>) {
  const normalized = Object.fromEntries(
    Object.entries(collections).map(([addr, service]) => [normalizeAddress("STARKNET", addr), service]),
  );
  return {
    collection: {
      async findUnique({ where }: { where: { chain_contractAddress: { contractAddress: string } } }) {
        const service = normalized[where.chain_contractAddress.contractAddress];
        return service ? { service } : null;
      },
    },
  } as never;
}

describe("createContractAddressChecker: platform contracts (fixed trust)", () => {
  test("accepts any allowed entrypoint on a Medialane-controlled contract", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("register_order", coords.marketplace721!)).toBe(true);
    expect(await checker.isEligible("register_order", coords.marketplace1155!)).toBe(true);
    expect(await checker.isEligible("create_creator_coin", coords.creatorCoinFactory!)).toBe(true);
    expect(await checker.isEligible("create_collection", coords.collection721!)).toBe(true);
    // The bug this test guards against: mint targets the same shared
    // registry contract as create_collection, not a per-creator contract.
    expect(await checker.isEligible("mint", coords.collection721!)).toBe(true);
  });

  test("rejects a call on an attacker-controlled contract", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("register_order", "0x999")).toBe(false);
  });

  test("does not trust a third-party contract like ekuboCore just because it's in coordinates", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("approve", coords.ekuboCore!)).toBe(false);
  });
});

describe("createContractAddressChecker: indexed Medialane collections", () => {
  test("accepts any allowed entrypoint on a collection the indexer knows a Medialane factory deployed", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "mip-erc721" }));
    expect(await checker.isEligible("mint", "0x42")).toBe(true);
    expect(await checker.isEligible("claim", "0x42")).toBe(true);
  });

  test("rejects a call on a contract the indexer has never indexed", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("mint", "0x42")).toBe(false);
  });

  test("restricts an external (non-Medialane-factory) collection to token-movement entrypoints only", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "external-erc721" }));
    expect(await checker.isEligible("approve", "0x42")).toBe(true);
    expect(await checker.isEligible("mint", "0x42")).toBe(false);
  });
});

describe("createContractAddressChecker: token contracts", () => {
  test("accepts approve on a supported currency token", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("approve", SUPPORTED_TOKENS[0].address)).toBe(true);
  });

  test("rejects approve on a contract that is neither a supported token nor an indexed collection", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("approve", "0x999")).toBe(false);
  });
});

describe("createContractAddressChecker: malformed input", () => {
  test("fails closed instead of throwing on a non-address contractAddress", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("mint", "not-an-address")).toBe(false);
  });
});
