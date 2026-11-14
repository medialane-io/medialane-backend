import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("accounts directory against Postgres", () => {
  let prisma: PrismaClient;
  let routes: typeof import("./accounts.js").accountsRoutes;
  const stamp = Date.now().toString(16);
  const chain = "STARKNET" as const;
  const address = (tag: string) => `0x${tag}${stamp}`;
  const [owner, hiddenCollectionOwner, hiddenCreator, holder, emptyHolder] = ["a1", "b2", "c3", "d4", "e5"].map(address);
  const service = `test-accounts-${stamp}`;
  const collection = (contractAddress: string, ownerAddress: string, isHidden = false) => ({
    chain, contractAddress, owner: ownerAddress, standard: "ERC721" as const, service, startBlock: 1n, isHidden,
  });
  const balance = (ownerAddress: string, tokenId: string, amount = "1") => ({
    chain, contractAddress: `0xtoken${stamp}`, tokenId, owner: ownerAddress, amount,
  });

  const list = async (query = "") => {
    const res = await routes.request(`/?search=${stamp}${query}`);
    return (await res.json()) as { data: { address: string; collections: number; assets: number }[]; meta: { total: number } };
  };

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    routes = (await import("./accounts.js")).accountsRoutes;
    await prisma.collection.createMany({
      data: [
        collection(`0xc1${stamp}`, owner),
        collection(`0xc2${stamp}`, owner),
        collection(`0xc3${stamp}`, hiddenCollectionOwner, true),
        collection(`0xc4${stamp}`, hiddenCreator),
      ],
    });
    await prisma.tokenBalance.createMany({
      data: [
        balance(owner, "1"),
        balance(owner, "2"),
        balance(holder, "3"),
        balance(hiddenCollectionOwner, "4"),
        balance(emptyHolder, "5", "0"),
      ],
    });
    await prisma.hiddenCreator.create({ data: { chain, address: hiddenCreator } });
  });

  afterAll(async () => {
    await prisma.tokenBalance.deleteMany({ where: { contractAddress: `0xtoken${stamp}` } });
    await prisma.collection.deleteMany({ where: { service } });
  });

  test("lists collection owners and holders with their counts, most active first, ties by address", async () => {
    const body = await list();
    expect(body.data).toEqual([
      { address: owner, collections: 2, assets: 2 },
      { address: hiddenCollectionOwner, collections: 0, assets: 1 },
      { address: holder, collections: 0, assets: 1 },
    ]);
    expect(body.meta.total).toBe(3);
  });

  test("leaves out empty balances, hidden collections and hidden creators", async () => {
    const addresses = (await list()).data.map((row) => row.address);
    expect(addresses).not.toContain(emptyHolder);
    expect(addresses).not.toContain(hiddenCreator);
  });

  test("paginates and keeps the total", async () => {
    const body = await list("&limit=2&page=2");
    expect(body.data.map((row) => row.address)).toEqual([holder]);
    expect(body.meta.total).toBe(3);
  });
});
