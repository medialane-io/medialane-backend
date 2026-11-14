import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("accounts directory against Postgres", () => {
  let prisma: PrismaClient;
  let routes: typeof import("./accounts.js").accountsRoutes;
  const stamp = Date.now().toString(16);
  const chain = "STARKNET" as const;
  const address = (tag: string) => `0x${tag}${stamp}`;
  const [maker, bare, listener, hiddenMaker, hiddenCreator, emptyHolder] = ["a1", "b2", "c3", "d4", "e5", "f6"].map(address);
  const service = `test-accounts-${stamp}`;
  const artContract = `0xa0${stamp}`;
  const audioContract = `0xa1${stamp}`;
  const bareContract = `0xa2${stamp}`;
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

  const collection = (contractAddress: string, owner: string | null, isHidden = false, createdAt = at(0)) => ({
    chain, contractAddress, owner, standard: "ERC721" as const, service, startBlock: 1n, isHidden, createdAt,
  });
  const token = (contractAddress: string, tokenId: string, image: string | null, ipType: string | null, isHidden = false) => ({
    chain, contractAddress, tokenId, image, ipType, isHidden,
  });
  const balance = (owner: string, contractAddress: string, tokenId: string, updatedAt: Date, amount = "1") => ({
    chain, contractAddress, tokenId, owner, amount, updatedAt,
  });

  const list = async (query = "") => {
    const res = await routes.request(`/?search=${stamp}${query}`);
    return (await res.json()) as { data: { address: string; image: string | null; ipType: string | null }[]; meta: { total: number } };
  };

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    routes = (await import("./accounts.js")).accountsRoutes;
    await prisma.collection.createMany({
      data: [
        collection(artContract, null),
        collection(audioContract, null),
        collection(bareContract, null),
        collection(`0xc0${stamp}`, maker, false, at(10)),
        collection(`0xc1${stamp}`, hiddenMaker, true, at(50)),
        collection(`0xc2${stamp}`, hiddenCreator, false, at(60)),
      ],
    });
    await prisma.token.createMany({
      data: [
        token(artContract, "1", "ipfs://art", "Art"),
        token(audioContract, "1", "ipfs://audio", "Audio"),
        token(artContract, "2", "ipfs://hidden", "Art", true),
        token(bareContract, "1", null, null),
      ],
    });
    await prisma.tokenBalance.createMany({
      data: [
        balance(maker, audioContract, "1", at(1)),
        balance(maker, artContract, "1", at(30)),
        balance(listener, audioContract, "1", at(20)),
        balance(bare, bareContract, "1", at(40)),
        balance(bare, artContract, "2", at(41)),
        balance(emptyHolder, artContract, "1", at(70), "0"),
      ],
    });
    await prisma.hiddenCreator.create({ data: { chain, address: hiddenCreator } });
  });

  afterAll(async () => {
    await prisma.tokenBalance.deleteMany({ where: { contractAddress: { in: [artContract, audioContract, bareContract] } } });
    await prisma.token.deleteMany({ where: { contractAddress: { in: [artContract, audioContract, bareContract] } } });
    await prisma.collection.deleteMany({ where: { service } });
  });

  test("lists every account, most recently active first, each with its latest visible asset", async () => {
    const body = await list();
    expect(body.data).toEqual([
      { address: bare, image: null, ipType: null },
      { address: maker, image: "ipfs://art", ipType: "Art" },
      { address: listener, image: "ipfs://audio", ipType: "Audio" },
    ]);
    expect(body.meta.total).toBe(3);
  });

  test("leaves out empty balances, hidden collections and hidden creators", async () => {
    const addresses = (await list()).data.map((row) => row.address);
    expect(addresses).not.toContain(emptyHolder);
    expect(addresses).not.toContain(hiddenMaker);
    expect(addresses).not.toContain(hiddenCreator);
  });

  test("a type of work keeps the accounts holding it and features that asset", async () => {
    expect((await list("&ipType=audio")).data).toEqual([
      { address: listener, image: "ipfs://audio", ipType: "Audio" },
      { address: maker, image: "ipfs://audio", ipType: "Audio" },
    ]);
    expect((await list("&ipType=art")).data).toEqual([{ address: maker, image: "ipfs://art", ipType: "Art" }]);
  });

  test("nft covers assets without a type", async () => {
    expect((await list("&ipType=nft")).data.map((row) => row.address)).toEqual([bare]);
  });

  test("paginates and keeps the total", async () => {
    const body = await list("&limit=2&page=2");
    expect(body.data.map((row) => row.address)).toEqual([listener]);
    expect(body.meta.total).toBe(3);
  });
});
