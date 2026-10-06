import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("collection stats against Postgres", () => {
  let prisma: PrismaClient;
  const contractAddress = `0x57a${Date.now().toString(16)}`;
  const where = { chain: "STARKNET" as const, contractAddress };

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    await prisma.collection.create({ data: { ...where, standard: "ERC1155", service: "test", startBlock: 1n } });
    await prisma.tokenBalance.createMany({
      data: [
        { ...where, tokenId: "1", owner: "0xa", amount: "2" },
        { ...where, tokenId: "2", owner: "0xa", amount: "1" },
        { ...where, tokenId: "1", owner: "0xb", amount: "4" },
        { ...where, tokenId: "1", owner: "0xc", amount: "0" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.tokenBalance.deleteMany({ where });
    await prisma.collection.deleteMany({ where });
    await prisma.$disconnect();
  });

  test("holders and supply count only non-zero balances", async () => {
    const { handleStatsUpdate } = await import("./stats.js");
    await handleStatsUpdate({ chain: "STARKNET", contractAddress });
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: where },
      select: { holderCount: true, totalSupply: true },
    });
    expect(col).toEqual({ holderCount: 2, totalSupply: 7 });
  });
});
