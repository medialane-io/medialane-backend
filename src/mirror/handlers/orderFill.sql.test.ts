import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("order fills against Postgres", () => {
  let prisma: PrismaClient;
  const orderHash = `0xf11${Date.now().toString(16)}`;
  const chain = "STARKNET" as const;

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    await prisma.order.create({
      data: {
        chain,
        orderHash,
        offerer: "0xseller",
        offerItemType: "ERC1155",
        offerToken: "0xnft",
        offerIdentifier: "1",
        offerStartAmount: "10",
        offerEndAmount: "10",
        considerationItemType: "ERC20",
        considerationToken: "0xusdc",
        considerationIdentifier: "0",
        considerationStartAmount: "100",
        considerationEndAmount: "100",
        considerationRecipient: "0xseller",
        startTime: 0n,
        endTime: 0n,
        status: "ACTIVE",
        createdBlockNumber: 1n,
        createdTxHash: "0xcreate",
        priceRaw: "100",
        nftContract: "0xnft",
        nftTokenId: "1",
      },
    });
  });

  afterAll(async () => {
    await prisma.orderFill.deleteMany({ where: { chain, orderHash } });
    await prisma.order.deleteMany({ where: { chain, orderHash } });
    await prisma.$disconnect();
  });

  const fill = (txHash: string, logIndex: number, quantity: string, remainingAmount: string) => ({
    chain,
    orderHash,
    fulfiller: "0xbuyer",
    txHash,
    logIndex,
    blockNumber: 5n,
    quantity,
    remainingAmount,
  });

  const fillsIn = (txHash: string) => prisma.orderFill.count({ where: { chain, orderHash, txHash } });

  test("the same sale read at two different log indexes is recorded once", async () => {
    const { recordOrderFill } = await import("./orderFill.js");

    await recordOrderFill(fill("0xsale", 4, "2", "8"), prisma);
    await recordOrderFill(fill("0xsale", 0, "2", "8"), prisma);

    expect(await fillsIn("0xsale")).toBe(1);
  });

  test("two partial fills of one order in one transaction are both recorded", async () => {
    const { recordOrderFill } = await import("./orderFill.js");

    await recordOrderFill(fill("0xcart", 3, "2", "6"), prisma);
    await recordOrderFill(fill("0xcart", 7, "2", "4"), prisma);

    expect(await fillsIn("0xcart")).toBe(2);
  });
});
