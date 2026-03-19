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

  // Count unique holders — raw SQL avoids loading all token rows into JS
  const [{ count: holderCountBig }] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT owner)::bigint AS count
    FROM "Token"
    WHERE chain = ${chain}::"Chain"
      AND "contractAddress" = ${contractAddress}
  `;
  const holderCount = Number(holderCountBig);

  // Count total supply
  const totalSupply = await prisma.token.count({
    where: { chain, contractAddress },
  });

  // Calculate floor price from active orders
  const activeOrders = await prisma.order.findMany({
    where: {
      chain,
      nftContract: contractAddress,
      status: "ACTIVE",
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
      floorPrice = token
        ? `${formatAmount(floor.priceRaw, token.decimals)} ${token.symbol}`
        : floor.priceRaw;
    }
  }

  // Calculate total volume from fulfilled orders
  const fulfilledOrders = await prisma.order.findMany({
    where: { chain, nftContract: contractAddress, status: "FULFILLED" },
    select: { priceRaw: true, considerationToken: true },
  });

  let totalVolumeRaw = 0n;
  for (const o of fulfilledOrders) {
    if (o.priceRaw) {
      try {
        totalVolumeRaw += BigInt(o.priceRaw);
      } catch {}
    }
  }

  await prisma.collection.update({
    where: { chain_contractAddress: { chain, contractAddress } },
    data: {
      holderCount,
      totalSupply,
      floorPrice,
      totalVolume: totalVolumeRaw.toString(),
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
