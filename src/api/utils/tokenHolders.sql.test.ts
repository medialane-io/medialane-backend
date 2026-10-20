import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("token holders", () => {
  let prisma: PrismaClient;
  let mod: typeof import("./tokenHolders.js");

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    mod = await import("./tokenHolders.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const balances = (contractAddress: string, rows: [string, string][]) =>
    prisma.tokenBalance.createMany({
      data: rows.map(([owner, amount]) => ({ chain: "STARKNET" as const, contractAddress, tokenId: "1", owner, amount })),
    });

  test("orders holders by amount as a number and counts every holder", async () => {
    await balances("0xa", [["0x1", "9"], ["0x2", "10"], ["0x3", "100"], ["0x4", "0"]]);
    const { holders, holderCount, supply } = await mod.tokenHolders("STARKNET", "0xa", "1");
    expect(holders.map((h) => h.amount)).toEqual(["100", "10", "9"]);
    expect(holderCount).toBe(3);
    expect(supply).toBe("119");
  });

  test("lists at most the limit while the count covers all holders", async () => {
    const n = mod.TOKEN_HOLDERS_LIMIT + 5;
    await balances("0xb", Array.from({ length: n }, (_, i) => [`0x${(i + 1).toString(16)}`, String(i + 1)] as [string, string]));
    const { holders, holderCount, supply } = await mod.tokenHolders("STARKNET", "0xb", "1");
    expect(holders).toHaveLength(mod.TOKEN_HOLDERS_LIMIT);
    expect(holders[0].amount).toBe(String(n));
    expect(holderCount).toBe(n);
    expect(supply).toBe(String((n * (n + 1)) / 2));
  });

  test("balance of an owner outside the listed holders", async () => {
    expect(await mod.tokenBalanceOf("STARKNET", "0xb", "1", "0x1")).toBe("1");
    expect(await mod.tokenBalanceOf("STARKNET", "0xb", "1", "0xdead")).toBe("0");
  });
});
