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

describe("createContractAddressChecker: fixed-target entrypoints", () => {
  test("accepts register_order on either marketplace address", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("register_order", coords.marketplace721!)).toBe(true);
    expect(await checker.isEligible("register_order", coords.marketplace1155!)).toBe(true);
  });

  test("rejects register_order on an attacker-controlled contract", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("register_order", "0x999")).toBe(false);
  });

  test("accepts create_creator_coin only on the creator coin factory", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("create_creator_coin", coords.creatorCoinFactory!)).toBe(true);
    expect(await checker.isEligible("create_creator_coin", "0x999")).toBe(false);
  });
});

describe("createContractAddressChecker: platform-collection entrypoints", () => {
  test("accepts mint on a collection the indexer knows was deployed by a Medialane factory", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "mip-erc721" }));
    expect(await checker.isEligible("mint", "0x42")).toBe(true);
  });

  test("rejects mint on an attacker-deployed contract the indexer has never indexed", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("mint", "0x42")).toBe(false);
  });

  test("rejects mint on an external (non-Medialane-factory) collection", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "external-erc721" }));
    expect(await checker.isEligible("mint", "0x42")).toBe(false);
  });
});

describe("createContractAddressChecker: token-or-collection entrypoints", () => {
  test("accepts approve on a supported currency token", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("approve", SUPPORTED_TOKENS[0].address)).toBe(true);
  });

  test("accepts approve on any indexed collection, including external ones", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "external-erc721" }));
    expect(await checker.isEligible("approve", "0x42")).toBe(true);
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
