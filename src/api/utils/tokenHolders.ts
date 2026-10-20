import type { Chain, PrismaClient } from "@prisma/client";
import prisma from "../../db/client.js";

export const TOKEN_HOLDERS_LIMIT = 50;

type Db = Pick<PrismaClient, "$queryRaw" | "tokenBalance">;

export interface TokenHoldersPage {
  page?: number;
  limit?: number;
}

export async function tokenHolders(
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  { page = 1, limit = TOKEN_HOLDERS_LIMIT }: TokenHoldersPage = {},
  db: Db = prisma,
) {
  const offset = (page - 1) * limit;
  const [holders, [totals]] = await Promise.all([
    db.$queryRaw<{ owner: string; amount: string }[]>`
      SELECT "owner", "amount" FROM "TokenBalance"
      WHERE "chain" = ${chain}::"Chain"
        AND "contractAddress" = ${contractAddress}
        AND "tokenId" = ${tokenId}
        AND "amount" <> '0'
      ORDER BY "amount"::numeric DESC, "owner" ASC
      LIMIT ${limit} OFFSET ${offset}
    `,
    db.$queryRaw<[{ holderCount: number; supply: string }]>`
      SELECT COUNT(*)::int AS "holderCount", COALESCE(SUM("amount"::numeric), 0)::text AS "supply"
      FROM "TokenBalance"
      WHERE "chain" = ${chain}::"Chain"
        AND "contractAddress" = ${contractAddress}
        AND "tokenId" = ${tokenId}
        AND "amount" <> '0'
    `,
  ]);
  return { holders, holderCount: totals.holderCount, supply: totals.supply };
}

export async function tokenBalanceOf(
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  owner: string,
  db: Db = prisma,
): Promise<string> {
  const row = await db.tokenBalance.findUnique({
    where: { chain_contractAddress_tokenId_owner: { chain, contractAddress, tokenId, owner } },
    select: { amount: true },
  });
  return row?.amount ?? "0";
}
