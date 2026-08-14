import { type Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { formatAmount } from "../utils/bigint.js";
import { getTokenByAddress } from "../config/constants.js";

const log = createLogger("orchestrator:stats");

export async function handleStatsUpdate(payload: {
  chain: string;
  contractAddress: string;
}): Promise<void> {
  const { contractAddress } = payload;
  const chain = payload.chain as Chain;

  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { standard: true, image: true, description: true },
  });

  const [{ count: holderCountBig }] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT owner)::bigint AS count
    FROM "TokenBalance"
    WHERE chain = ${chain}::"Chain"
      AND "contractAddress" = ${contractAddress}
      AND amount::numeric > 0
  `;
  const holderCount = Number(holderCountBig);
  let totalSupply: number;
  if (collection?.standard === "ERC1155") {
    const [{ total }] = await prisma.$queryRaw<[{ total: bigint }]>`
      SELECT COALESCE(SUM(amount::numeric), 0)::bigint AS total
      FROM "TokenBalance"
      WHERE chain = ${chain}::"Chain"
        AND "contractAddress" = ${contractAddress}
        AND amount::numeric > 0
    `;
    totalSupply = Number(total);
  } else {
    totalSupply = await prisma.token.count({ where: { chain, contractAddress } });
  }

  const floorRows = await prisma.$queryRaw<{ priceRaw: string; considerationToken: string | null }[]>`
    SELECT "priceRaw", "considerationToken"
    FROM "Order"
    WHERE chain = ${chain}::"Chain"
      AND "nftContract" = ${contractAddress}
      AND status = 'ACTIVE'
      AND "offerItemType" IN ('ERC721', 'ERC1155')
      AND "endTime" > ${BigInt(Math.floor(Date.now() / 1000))}
      AND "priceRaw" ~ '^[0-9]+$'
      AND "priceRaw"::numeric > 0
    ORDER BY "priceRaw"::numeric ASC
    LIMIT 1
  `;

  let floorPrice: string | null = null;
  let floorCurrency: string | null = null;
  const floor = floorRows[0];
  if (floor?.considerationToken) {
    const token = getTokenByAddress(floor.considerationToken);
    if (token) {
      floorPrice = formatAmount(floor.priceRaw, token.decimals);
      floorCurrency = token.symbol;
    }
  }

  const volumeRows = await prisma.$queryRaw<{ currencyToken: string; total: string }[]>`
    SELECT "currencyToken", SUM("priceRaw"::numeric)::text AS total
    FROM "OrderFill"
    WHERE chain = ${chain}::"Chain"
      AND "nftContract" = ${contractAddress}
      AND "currencyToken" IS NOT NULL
      AND "priceRaw" ~ '^[0-9]+$'
    GROUP BY "currencyToken"
    ORDER BY SUM("priceRaw"::numeric) DESC
    LIMIT 1
  `;

  let totalVolume: string | null = null;
  let volumeCurrency: string | null = null;
  const dominant = volumeRows[0];
  if (dominant) {
    const token = getTokenByAddress(dominant.currencyToken);
    if (token) {
      totalVolume = formatAmount(dominant.total, token.decimals);
      volumeCurrency = token.symbol;
    }
  }

  await prisma.collection.update({
    where: { chain_contractAddress: { chain, contractAddress } },
    data: {
      holderCount,
      totalSupply,
      floorPrice,
      floorCurrency,
      totalVolume,
      volumeCurrency,
    },
  });

  if (!collection?.image || !collection?.description) {
    const firstToken = await prisma.token.findFirst({
      where: { chain, contractAddress, metadataStatus: "FETCHED" },
      orderBy: { tokenId: "asc" },
      select: { image: true, description: true },
    });

    if (firstToken && (firstToken.image || firstToken.description)) {
      await prisma.collection.update({
        where: { chain_contractAddress: { chain, contractAddress } },
        data: {
          image: collection?.image ?? firstToken.image,
          description: collection?.description ?? firstToken.description,
        },
      });
    }
  }

  log.debug(
    { chain, contractAddress, holderCount, totalSupply, floorPrice },
    "Stats updated"
  );
}
