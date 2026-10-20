import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("ownership writes against Postgres", () => {
  let prisma: PrismaClient;
  const contract = `0x0a1${Date.now().toString(16)}`;
  const where = { chain: "STARKNET" as const, contractAddress: contract };

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
  });

  beforeEach(async () => {
    await prisma.tokenBalance.deleteMany({ where });
  });

  afterAll(async () => {
    await prisma.tokenBalance.deleteMany({ where });
    await prisma.$disconnect();
  });

  const seed = (tokenId: string, owner: string, amount: string) =>
    prisma.tokenBalance.create({ data: { ...where, tokenId, owner, amount } });

  const rows = async (tokenId: string) =>
    (await prisma.tokenBalance.findMany({ where: { ...where, tokenId }, orderBy: { owner: "asc" } }))
      .map((r) => [r.owner, r.amount]);

  const erc721 = (tokenId: string, owner: string | null) =>
    ({ standard: "ERC721" as const, contractAddress: contract, tokenId, owner });
  const erc1155 = (tokenId: string, owner: string, amount: bigint) =>
    ({ standard: "ERC1155" as const, contractAddress: contract, tokenId, owner, amount });

  test("an erc721 owner replaces whoever held the token before", async () => {
    const { writeOwnership } = await import("./ownership.js");
    await seed("1", "0xa", "1");
    await writeOwnership(prisma, "STARKNET", [erc721("1", "0xb")]);
    expect(await rows("1")).toEqual([["0xb", "1"]]);
  });

  test("an erc721 token with no owner has no rows", async () => {
    const { writeOwnership } = await import("./ownership.js");
    await seed("1", "0xa", "1");
    await writeOwnership(prisma, "STARKNET", [erc721("1", null)]);
    expect(await rows("1")).toEqual([]);
  });

  test("writing the same erc721 fact twice changes nothing", async () => {
    const { writeOwnership } = await import("./ownership.js");
    await writeOwnership(prisma, "STARKNET", [erc721("1", "0xb")]);
    await writeOwnership(prisma, "STARKNET", [erc721("1", "0xb")]);
    expect(await rows("1")).toEqual([["0xb", "1"]]);
  });

  test("an erc1155 amount is stored exactly as read", async () => {
    const { writeOwnership } = await import("./ownership.js");
    await seed("2", "0xa", "9");
    await writeOwnership(prisma, "STARKNET", [erc1155("2", "0xa", 4n)]);
    expect(await rows("2")).toEqual([["0xa", "4"]]);
  });

  test("an erc1155 amount of zero removes the row", async () => {
    const { writeOwnership } = await import("./ownership.js");
    await seed("2", "0xa", "9");
    await writeOwnership(prisma, "STARKNET", [erc1155("2", "0xa", 0n)]);
    expect(await rows("2")).toEqual([]);
  });

  test("erc1155 holders not in the facts are left as they are", async () => {
    const { writeOwnership } = await import("./ownership.js");
    await seed("2", "0xa", "3");
    await seed("2", "0xb", "1");
    await writeOwnership(prisma, "STARKNET", [erc1155("2", "0xb", 2n)]);
    expect(await rows("2")).toEqual([["0xa", "3"], ["0xb", "2"]]);
  });
});
