import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { ZERO_ADDRESS } from "../../config/constants.js";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("transfer handlers against Postgres", () => {
  let prisma: PrismaClient;
  const contract = `0xba1${Date.now().toString(16)}`;
  const where = { chain: "STARKNET" as const, contractAddress: contract };

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    await prisma.collection.create({ data: { ...where, standard: "ERC1155", service: "test", startBlock: 1n } });
  });

  afterAll(async () => {
    await prisma.transfer.deleteMany({ where });
    await prisma.tokenBalance.deleteMany({ where });
    await prisma.token.deleteMany({ where });
    await prisma.collection.deleteMany({ where });
    await prisma.$disconnect();
  });

  const balanceRows = () => prisma.tokenBalance.count({ where });
  const transferRows = () => prisma.transfer.count({ where });

  const single = (from: string, to: string, amount: string, logIndex: number) => ({
    type: "TransferSingle" as const,
    contractAddress: contract,
    operator: from,
    from,
    to,
    tokenId: "1",
    amount,
    blockNumber: 1n,
    txHash: `0x${logIndex}`,
    logIndex,
  });

  test("transfer handlers record the movement and leave ownership to the ownership writer", async () => {
    const { handleTransferSingle } = await import("./transfer.js");
    await handleTransferSingle(single(ZERO_ADDRESS, "0xa", "5", 1), prisma, "STARKNET");
    await handleTransferSingle(single("0xa", "0xb", "2", 2), prisma, "STARKNET");
    expect(await transferRows()).toBe(2);
    expect(await balanceRows()).toBe(0);
  });

  test("replaying the same transfer records it once", async () => {
    const { handleTransferSingle } = await import("./transfer.js");
    await handleTransferSingle(single("0xb", "0xc", "1", 5), prisma, "STARKNET");
    await handleTransferSingle(single("0xb", "0xc", "1", 5), prisma, "STARKNET");
    expect(await prisma.transfer.count({ where: { ...where, txHash: "0x5" } })).toBe(1);
  });
});
