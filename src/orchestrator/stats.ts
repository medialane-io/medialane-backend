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

  // Count total supply.
  // ERC-721: count distinct Token rows (one per unique token ID).
  // ERC-1155: sum all TokenBalance amounts — a single token ID can be held by many wallets,
  //           so counting rows would give 348 for Lil Duckies instead of the real 8,745.
  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { standard: true },
  });
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

  // Calculate floor price from active listing orders only.
  // Bids (offerItemType = "ERC20") are excluded — their considerationToken is the NFT address,
  // not a currency, so they cannot be priced correctly here. Floor price = cheapest active listing.
  const activeOrders = await prisma.order.findMany({
    where: {
      chain,
      nftContract: contractAddress,
      status: "ACTIVE",
      offerItemType: "ERC721",
      endTime: { gt: BigInt(Math.floor(Date.now() / 1000)) },
      priceRaw: { not: null },
    },
    select: { priceRaw: true, considerationToken: true },
  });

  let floorPrice: string | null = null;
  // Filter out zero or missing prices before sorting — a priceRaw of "0" would
  // otherwise always win as the floor, masking real listings.
  const positiveOrders = activeOrders.filter((o) => {
    try { return BigInt(o.priceRaw ?? "0") > 0n; } catch { return false; }
  });
  if (positiveOrders.length > 0) {
    // Sort numerically — priceRaw is stored as a decimal string
    positiveOrders.sort((a, b) => {
      const aVal = BigInt(a.priceRaw ?? "0");
      const bVal = BigInt(b.priceRaw ?? "0");
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    });
    const floor = positiveOrders[0];
    if (floor.priceRaw) {
      const token = floor.considerationToken
        ? getTokenByAddress(floor.considerationToken)
        : null;
      if (token) {
        floorPrice = `${formatAmount(floor.priceRaw, token.decimals)} ${token.symbol}`;
      }
      // token is null: considerationToken missing or unrecognised — don't store raw wei
    }
  }

  // Calculate total volume from fulfilled orders, grouped by currency token.
  // Mirror the floorPrice approach: format as human-readable + symbol.
  // If sales span multiple currencies, pick the one with the highest raw volume.
  const fulfilledOrders = await prisma.order.findMany({
    where: { chain, nftContract: contractAddress, status: "FULFILLED" },
    select: { priceRaw: true, considerationToken: true },
  });

  const volumeByToken = new Map<string, bigint>();
  for (const o of fulfilledOrders) {
    if (o.priceRaw && o.considerationToken) {
      try {
        const prev = volumeByToken.get(o.considerationToken) ?? 0n;
        volumeByToken.set(o.considerationToken, prev + BigInt(o.priceRaw));
      } catch {}
    }
  }

  let totalVolume: string | null = null;
  if (volumeByToken.size > 0) {
    let maxVol = 0n;
    let dominantTokenAddr: string | null = null;
    for (const [tokenAddr, vol] of volumeByToken) {
      if (vol > maxVol) {
        maxVol = vol;
        dominantTokenAddr = tokenAddr;
      }
    }
    if (dominantTokenAddr) {
      const token = getTokenByAddress(dominantTokenAddr);
      if (token) {
        totalVolume = `${formatAmount(maxVol.toString(), token.decimals)} ${token.symbol}`;
      }
    }
  }

  await prisma.collection.update({
    where: { chain_contractAddress: { chain, contractAddress } },
    data: {
      holderCount,
      totalSupply,
      floorPrice,
      totalVolume,
    },
  });

  // Backfill image/description from first fetched token if not yet set.
  // name/symbol come from the COLLECTION_METADATA_FETCH job (on-chain view calls).
  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { image: true, description: true },
  });

  if (!existing?.image || !existing?.description) {
    const firstToken = await prisma.token.findFirst({
      where: { chain, contractAddress, metadataStatus: "FETCHED" },
      orderBy: { tokenId: "asc" },
      select: { image: true, description: true },
    });

    if (firstToken && (firstToken.image || firstToken.description)) {
      await prisma.collection.update({
        where: { chain_contractAddress: { chain, contractAddress } },
        data: {
          image: existing?.image ?? firstToken.image,
          description: existing?.description ?? firstToken.description,
        },
      });
    }
  }

  log.debug(
    { chain, contractAddress, holderCount, totalSupply, floorPrice },
    "Stats updated"
  );
}
