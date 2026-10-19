import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const UNKNOWN = "0x0123";

describe.skipIf(!databaseUrl)("collection stats against Postgres", () => {
  let prisma: PrismaClient;
  let mod: typeof import("./collectionStats.js");
  const service = `test-stats-${Date.now().toString(16)}`;
  const erc721 = `0x721${Date.now().toString(16)}`;
  const erc1155 = `0x1155${Date.now().toString(16)}`;
  const empty = `0xe${Date.now().toString(16)}`;
  const chain = "STARKNET" as const;
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const past = BigInt(Math.floor(Date.now() / 1000) - 3600);

  const order = (hash: string, priceRaw: string, token: string, endTime = future, status: "ACTIVE" | "CANCELLED" = "ACTIVE") => ({
    chain, orderHash: hash, offerer: "0xo", offerItemType: "ERC721", offerToken: erc721, offerIdentifier: "1",
    offerStartAmount: "1", offerEndAmount: "1", considerationItemType: "ERC20", considerationToken: token,
    considerationIdentifier: "0", considerationStartAmount: priceRaw, considerationEndAmount: priceRaw,
    considerationRecipient: "0xo", startTime: 0n, endTime, status, createdBlockNumber: 1n, createdTxHash: hash,
    nftContract: erc721, nftTokenId: "1", priceRaw,
  });

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    mod = await import("./collectionStats.js");
    await prisma.collection.createMany({
      data: [
        { chain, contractAddress: erc721, standard: "ERC721", service, startBlock: 1n, createdAt: new Date(3000) },
        { chain, contractAddress: erc1155, standard: "ERC1155", service, startBlock: 1n, createdAt: new Date(2000) },
        { chain, contractAddress: empty, standard: "ERC721", service, startBlock: 1n, createdAt: new Date(1000) },
      ],
    });
    await prisma.token.createMany({
      data: ["1", "2", "3"].map((tokenId) => ({ chain, contractAddress: erc721, tokenId })),
    });
    await prisma.tokenBalance.createMany({
      data: [
        { chain, contractAddress: erc721, tokenId: "1", owner: "0xa", amount: "1" },
        { chain, contractAddress: erc721, tokenId: "2", owner: "0xa", amount: "1" },
        { chain, contractAddress: erc721, tokenId: "3", owner: "0xb", amount: "1" },
        { chain, contractAddress: erc1155, tokenId: "1", owner: "0xa", amount: "2" },
        { chain, contractAddress: erc1155, tokenId: "2", owner: "0xa", amount: "1" },
        { chain, contractAddress: erc1155, tokenId: "1", owner: "0xb", amount: "4" },
        { chain, contractAddress: erc1155, tokenId: "1", owner: "0xc", amount: "0" },
      ],
    });
    await prisma.order.createMany({
      data: [
        order(`${erc721}-1`, "5000000000000000000", STRK),
        order(`${erc721}-2`, "1", STRK, past),
        order(`${erc721}-3`, "2", STRK, future, "CANCELLED"),
        order(`${erc721}-4`, "3", UNKNOWN),
      ],
    });
    await prisma.orderFill.createMany({
      data: [
        { chain, orderHash: `${erc721}-1`, fulfiller: "0xf", priceRaw: "2000000000000000000", currencyToken: STRK, nftContract: erc721, txHash: "0x1", logIndex: 0, blockNumber: 1n },
        { chain, orderHash: `${erc721}-1`, fulfiller: "0xf", priceRaw: "3000000000000000000", currencyToken: STRK, nftContract: erc721, txHash: "0x2", logIndex: 0, blockNumber: 1n },
        { chain, orderHash: `${erc721}-1`, fulfiller: "0xf", priceRaw: "1000000", currencyToken: USDC, nftContract: erc721, txHash: "0x3", logIndex: 0, blockNumber: 1n },
      ],
    });
  });

  afterAll(async () => {
    const contracts = { in: [erc721, erc1155, empty] };
    await prisma.orderFill.deleteMany({ where: { nftContract: contracts } });
    await prisma.order.deleteMany({ where: { nftContract: contracts } });
    await prisma.tokenBalance.deleteMany({ where: { contractAddress: contracts } });
    await prisma.token.deleteMany({ where: { contractAddress: contracts } });
    await prisma.collection.deleteMany({ where: { contractAddress: contracts } });
    await prisma.$disconnect();
  });

  test("counts items and holders from tokens and non-zero balances", async () => {
    const stats = await mod.batchCollectionStats([erc721, erc1155, empty].map((contractAddress) => ({ chain, contractAddress })));
    expect(stats.get(erc721)).toMatchObject({ totalSupply: 3, holderCount: 2 });
    expect(stats.get(erc1155)).toMatchObject({ totalSupply: 7, holderCount: 2 });
    expect(stats.get(empty)).toEqual({ totalSupply: 0, holderCount: 0, floorPrice: null, totalVolume: null });
  });

  test("floor is the cheapest active, unexpired listing in a supported currency", async () => {
    const stats = await mod.batchCollectionStats([{ chain, contractAddress: erc721 }]);
    expect(stats.get(erc721)?.floorPrice).toBe("5.000000000000000000 STRK");
  });

  test("volume is the sum of sales in the currency with the most volume", async () => {
    const stats = await mod.batchCollectionStats([{ chain, contractAddress: erc721 }]);
    expect(stats.get(erc721)?.totalVolume).toBe("5.000000000000000000 STRK");
  });

  test("the collection list hides empty collections and sorts by counted supply", async () => {
    const collections = (await import("../routes/collections.js")).default;
    const res = await collections.request(`/?service=${service}&hideEmpty=true&sort=supply`);
    const body = (await res.json()) as { data: { contractAddress: string; totalSupply: number }[]; meta: { total: number } };
    expect(body.data.map((c) => [c.contractAddress, c.totalSupply])).toEqual([[erc1155, 7], [erc721, 3]]);
    expect(body.meta.total).toBe(2);
  });

  test("the collection list returns counted stats on every sort", async () => {
    const collections = (await import("../routes/collections.js")).default;
    const res = await collections.request(`/?service=${service}`);
    const body = (await res.json()) as { data: { contractAddress: string; totalSupply: number; holderCount: number }[] };
    expect(body.data.map((c) => [c.contractAddress, c.totalSupply, c.holderCount])).toEqual([
      [erc721, 3, 2],
      [erc1155, 7, 2],
      [empty, 0, 0],
    ]);
  });
});
