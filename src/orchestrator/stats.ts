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

  // Count unique holders
  const holderResult = await prisma.token.groupBy({
    by: ["owner"],
    where: { chain, contractAddress },
    _count: { owner: true },
  });
  const holderCount = holderResult.length;

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
  if (activeOrders.length > 0) {
    // Sort numerically — priceRaw is stored as a decimal string
    activeOrders.sort((a, b) => {
      const aVal = BigInt(a.priceRaw ?? "0");
      const bVal = BigInt(b.priceRaw ?? "0");
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    });
    const floor = activeOrders[0];
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

  log.debug(
    { chain, contractAddress, holderCount, totalSupply, floorPrice },
    "Stats updated"
  );
}
