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

  // Single upfront read — reused for both totalSupply branching and image/description backfill.
  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { standard: true, image: true, description: true },
  });

  // Count unique holders via TokenBalance (works for both ERC-721 and ERC-1155).
  // Filters amount > 0 so former holders who transferred out are excluded.
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

  // Floor price = cheapest active listing, resolved in ONE indexed query.
  // Bids (offerItemType = "ERC20") are excluded — their considerationToken is
  // the NFT address, not a currency. Zero prices are excluded so a "0" listing
  // can't mask real ones. The numeric regex guard keeps a malformed priceRaw
  // from failing the whole query.
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

  // Stored shape: numeric-only decimal string + currency in its own column —
  // display composition happens at the serializer edge, never in the DB.
  // Unknown/missing currency → both null (raw wei is never stored).
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

  // Total volume = SUM of fills per currency, aggregated in SQL (ERC-1155
  // partial fills are separate OrderFill rows). If sales span multiple
  // currencies, keep the one with the highest raw volume.
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

  // Backfill image/description from first fetched token if not yet set.
  // name/symbol come from the COLLECTION_METADATA_FETCH job (on-chain view calls).
  // `collection` was already fetched above — no second DB round-trip needed.
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
