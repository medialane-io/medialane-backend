import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { ZERO_ADDRESS } from "../../config/constants.js";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("transfer balances against Postgres", () => {
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

  const balanceOf = async (owner: string) =>
    (await prisma.tokenBalance.findUnique({
      where: { chain_contractAddress_tokenId_owner: { ...where, tokenId: "1", owner } },
      select: { amount: true },
    }))?.amount;

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

  test("a mint, a move and an over-move leave exact, never negative balances", async () => {
    const { handleTransferSingle } = await import("./transfer.js");

    await handleTransferSingle(single(ZERO_ADDRESS, "0xa", "5", 1), prisma, "STARKNET");
    await handleTransferSingle(single("0xa", "0xb", "2", 2), prisma, "STARKNET");
    expect(await balanceOf("0xa")).toBe("3");
    expect(await balanceOf("0xb")).toBe("2");

    await handleTransferSingle(single("0xa", "0xb", "3", 3), prisma, "STARKNET");
    expect(await balanceOf("0xa")).toBe("0");

    await handleTransferSingle(single("0xa", "0xb", "4", 4), prisma, "STARKNET");
    expect(await balanceOf("0xa")).toBe("0");
    expect(await balanceOf("0xb")).toBe("9");
  });

  const inTx = (txHash: string, from: string, to: string, amount: string, logIndex: number) => ({
    ...single(from, to, amount, logIndex),
    txHash,
  });

  test("two identical moves at different event indexes in one tx both count", async () => {
    const { handleTransferSingle } = await import("./transfer.js");
    await handleTransferSingle(inTx("0xtwin", ZERO_ADDRESS, "0xd", "1", 10), prisma, "STARKNET");
    await handleTransferSingle(inTx("0xtwin", ZERO_ADDRESS, "0xd", "1", 11), prisma, "STARKNET");
    expect(await balanceOf("0xd")).toBe("2");
  });

  test("re-applying a stored transfer inside a transaction does not abort it", async () => {
    const { handleTransferSingle } = await import("./transfer.js");
    await handleTransferSingle(inTx("0xagain", ZERO_ADDRESS, "0xe", "1", 0), prisma, "STARKNET");
    await prisma.$transaction(async (tx) => {
      await handleTransferSingle(inTx("0xagain", ZERO_ADDRESS, "0xe", "1", 0), tx, "STARKNET");
      await tx.collection.findFirst({ where });
    });
    expect(await balanceOf("0xe")).toBe("1");
  });

  test("replaying the same transfer changes nothing", async () => {
    const { handleTransferSingle } = await import("./transfer.js");
    await handleTransferSingle(single("0xb", "0xc", "1", 5), prisma, "STARKNET");
    await handleTransferSingle(single("0xb", "0xc", "1", 5), prisma, "STARKNET");
    expect(await balanceOf("0xc")).toBe("1");
  });
});
