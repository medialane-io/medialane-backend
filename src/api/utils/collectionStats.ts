import { Prisma, type Chain } from "@prisma/client";
import prisma from "../../db/client.js";
import { SUPPORTED_TOKENS } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import { normalizeAddress } from "../../utils/starknet.js";

export interface CollectionStats {
  holderCount: number;
  totalSupply: number;
  floorPrice: string | null;
  totalVolume: string | null;
}

interface RawStatsRow {
  contractAddress: string;
  holderCount: number;
  totalSupply: bigint;
  floorRaw: string | null;
  floorCurrency: string | null;
  floorDecimals: number | null;
  volumeRaw: string | null;
  volumeCurrency: string | null;
  volumeDecimals: number | null;
}

const currencies = Prisma.sql`(VALUES ${Prisma.join(
  SUPPORTED_TOKENS.map((t) => Prisma.sql`(${normalizeAddress("STARKNET", t.address)}, ${t.symbol}, ${t.decimals}::int)`),
)}) AS cur(address, symbol, decimals)`;

export const collectionHasTokens = Prisma.sql`(CASE WHEN c.standard = 'ERC1155'
  THEN EXISTS (SELECT 1 FROM "TokenBalance" b WHERE b.chain = c.chain AND b."contractAddress" = c."contractAddress" AND b.amount <> '0')
  ELSE EXISTS (SELECT 1 FROM "Token" t WHERE t.chain = c.chain AND t."contractAddress" = c."contractAddress")
END)`;

export const collectionTotalSupply = Prisma.sql`(CASE WHEN c.standard = 'ERC1155' THEN bal."balanceSum" ELSE tok."tokenCount" END)`;

export function collectionStatsJoin(): Prisma.Sql {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT b.owner)::int AS "holderCount",
             COALESCE(SUM(b.amount::numeric), 0) AS "balanceSum"
      FROM "TokenBalance" b
      WHERE b.chain = c.chain AND b."contractAddress" = c."contractAddress" AND b.amount <> '0'
    ) bal ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS "tokenCount"
      FROM "Token" t
      WHERE t.chain = c.chain AND t."contractAddress" = c."contractAddress"
    ) tok ON true
    LEFT JOIN LATERAL (
      SELECT o."priceRaw" AS "floorRaw", cur.symbol AS "floorCurrency", cur.decimals AS "floorDecimals"
      FROM "Order" o
      JOIN ${currencies} ON cur.address = o."considerationToken"
      WHERE o.chain = c.chain
        AND o."nftContract" = c."contractAddress"
        AND o.status = 'ACTIVE'
        AND o."offerItemType" IN ('ERC721', 'ERC1155')
        AND o."endTime" > ${nowSec}
        AND o."priceRaw" ~ '^[0-9]+$'
        AND o."priceRaw"::numeric > 0
      ORDER BY o."priceRaw"::numeric ASC
      LIMIT 1
    ) fl ON true
    LEFT JOIN LATERAL (
      SELECT SUM(f."priceRaw"::numeric)::text AS "volumeRaw", cur.symbol AS "volumeCurrency", cur.decimals AS "volumeDecimals"
      FROM "OrderFill" f
      JOIN ${currencies} ON cur.address = f."currencyToken"
      WHERE f.chain = c.chain
        AND f."nftContract" = c."contractAddress"
        AND f."priceRaw" ~ '^[0-9]+$'
      GROUP BY cur.symbol, cur.decimals
      ORDER BY SUM(f."priceRaw"::numeric) DESC
      LIMIT 1
    ) vol ON true
  `;
}

function amountDisplay(raw: string | null, decimals: number | null, currency: string | null): string | null {
  if (raw == null || decimals == null || currency == null) return null;
  return `${formatAmount(raw, decimals)} ${currency}`;
}

export async function batchCollectionStats(
  collections: { chain: Chain; contractAddress: string }[],
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<Map<string, CollectionStats>> {
  if (collections.length === 0) return new Map();
  const keys = collections.map((c) => Prisma.sql`(${c.chain}::"Chain", ${c.contractAddress})`);
  const rows = await db.$queryRaw<RawStatsRow[]>`
    SELECT c."contractAddress",
           bal."holderCount",
           ${collectionTotalSupply}::bigint AS "totalSupply",
           fl."floorRaw", fl."floorCurrency", fl."floorDecimals",
           vol."volumeRaw", vol."volumeCurrency", vol."volumeDecimals"
    FROM "Collection" c
    ${collectionStatsJoin()}
    WHERE (c.chain, c."contractAddress") IN (${Prisma.join(keys)})
  `;
  return new Map(
    rows.map((r) => [
      r.contractAddress,
      {
        holderCount: Number(r.holderCount),
        totalSupply: Number(r.totalSupply),
        floorPrice: amountDisplay(r.floorRaw, r.floorDecimals, r.floorCurrency),
        totalVolume: amountDisplay(r.volumeRaw, r.volumeDecimals, r.volumeCurrency),
      },
    ]),
  );
}
