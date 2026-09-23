import { describe, expect, test } from "bun:test";
import { getCoordinates, normalizeAddress, SUPPORTED_TOKENS } from "@medialane/sdk";
import { createContractAddressChecker } from "./paymaster-contract-address.js";

const coords = getCoordinates("STARKNET");

function fakeDb(collections: Record<string, string>, provisionedWallets: string[] = []) {
  const normalized = Object.fromEntries(
    Object.entries(collections).map(([addr, service]) => [normalizeAddress("STARKNET", addr), service]),
  );
  const provisioned = new Set(provisionedWallets.map((a) => normalizeAddress("STARKNET", a)));
  return {
    collection: {
      async findUnique({ where }: { where: { chain_contractAddress: { contractAddress: string } } }) {
        const service = normalized[where.chain_contractAddress.contractAddress];
        return service ? { service } : null;
      },
    },
    businessProvisioning: {
      async findFirst({ where }: { where: { walletAddress: string } }) {
        return provisioned.has(where.walletAddress) ? { id: "provisioning-1" } : null;
      },
    },
  } as never;
}

describe("createContractAddressChecker: platform contracts (fixed trust)", () => {
  test("accepts a Medialane-controlled contract", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible(coords.marketplace721!)).toBe(true);
    expect(await checker.isEligible(coords.marketplace1155!)).toBe(true);
    expect(await checker.isEligible(coords.creatorCoinFactory!)).toBe(true);
    expect(await checker.isEligible(coords.collection721!)).toBe(true);
  });

  test("accepts the Data Tokenization registry", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(coords.dataTokenization721).toBeDefined();
    expect(await checker.isEligible(coords.dataTokenization721!)).toBe(true);
  });

  test("rejects a contract nobody indexed", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("0x999")).toBe(false);
  });

  test("does not trust a third-party contract like ekuboCore just because it's in coordinates", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible(coords.ekuboCore!)).toBe(false);
  });
});

describe("createContractAddressChecker: indexed collections", () => {
  test("accepts a collection the indexer knows a Medialane factory deployed", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "mip-erc721" }));
    expect(await checker.isEligible("0x42")).toBe(true);
  });

  test("rejects a contract the indexer has never indexed", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("0x42")).toBe(false);
  });

  test("an indexed external collection is sponsored the same as a Medialane one", async () => {
    const checker = createContractAddressChecker(fakeDb({ "0x42": "external-erc721", "0x43": "external-erc1155" }));
    expect(await checker.isEligible("0x42")).toBe(true);
    expect(await checker.isEligible("0x43")).toBe(true);
  });
});

describe("createContractAddressChecker: token contracts", () => {
  test("accepts a supported currency token", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible(SUPPORTED_TOKENS[0].address)).toBe(true);
  });

  test("rejects a contract that is neither a supported token nor an indexed collection", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("0x999")).toBe(false);
  });
});

describe("createContractAddressChecker: malformed input", () => {
  test("fails closed instead of throwing on a non-address contractAddress", async () => {
    const checker = createContractAddressChecker(fakeDb({}));
    expect(await checker.isEligible("not-an-address")).toBe(false);
  });
});

describe("createContractAddressChecker: wallets Medialane provisioned", () => {
  const wallet = "0x071c174b93d24b72fc4b25e1d28fce1267e30c4c57fa4b0980a403a97fa84f5f";
  const stranger = "0x03a90664ef86880dbe6bf9c6c8f874177944a3e48b40463e8de60bcb3d4790f5";

  test("accepts a wallet we provisioned, so its handoff can be sponsored", async () => {
    const checker = createContractAddressChecker(fakeDb({}, [wallet]));
    expect(await checker.isEligible(wallet)).toBe(true);
  });

  test("accepts it written unpadded, because addresses arrive both ways", async () => {
    const checker = createContractAddressChecker(fakeDb({}, [wallet]));
    expect(await checker.isEligible("0x71c174b93d24b72fc4b25e1d28fce1267e30c4c57fa4b0980a403a97fa84f5f")).toBe(true);
  });

  test("rejects a wallet we never provisioned", async () => {
    const checker = createContractAddressChecker(fakeDb({}, [wallet]));
    expect(await checker.isEligible(stranger)).toBe(false);
  });
});
