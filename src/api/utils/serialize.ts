import prisma from "../../db/client.js";

const CURRENCY_DECIMALS: Record<string, number> = {
  USDC: 6,
  "USDC.E": 6, // legacy — existing DB orders only, never created via UI going forward
  USDT: 6,
  ETH: 18,
  STRK: 18,
  WBTC: 8,
};

/** Batch-fetch token name/image/description for a list of orders (single query). */
export async function batchTokenMeta(
  orders: { nftContract: string | null; nftTokenId: string | null }[]
): Promise<Map<string, { name: string | null; image: string | null; description: string | null }>> {
  const pairs = orders
    .filter((o) => o.nftContract && o.nftTokenId)
    .map((o) => ({ contractAddress: o.nftContract!, tokenId: o.nftTokenId! }));

  if (!pairs.length) return new Map();

  const tokens = await prisma.token.findMany({
    where: { chain: "STARKNET", OR: pairs },
    select: { contractAddress: true, tokenId: true, name: true, image: true, description: true },
  });

  return new Map(
    tokens.map((t) => [
      `${t.contractAddress}-${t.tokenId}`,
      { name: t.name, image: t.image, description: t.description },
    ])
  );
}

export function serializeToken(token: any, activeOrders: any[]) {
  return {
    id: token.id,
    chain: token.chain,
    contractAddress: token.contractAddress,
    tokenId: token.tokenId,
    owner: token.owner,
    tokenUri: token.tokenUri,
    metadataStatus: token.metadataStatus,
    metadata: {
      name: token.name,
      description: token.description,
      image: token.image,
      attributes: token.attributes,
      ipType: token.ipType,
      licenseType: token.licenseType,
      commercialUse: token.commercialUse,
      author: token.author,
    },
    activeOrders: activeOrders.map((o) => serializeOrder(o)),
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

export function serializeOrder(
  o: any,
  tokenData?: { name: string | null; image: string | null; description: string | null } | null
) {
  return {
    id: o.id,
    chain: o.chain,
    orderHash: o.orderHash,
    offerer: o.offerer,
    offer: {
      itemType: o.offerItemType,
      token: o.offerToken,
      identifier: o.offerIdentifier,
      startAmount: o.offerStartAmount,
      endAmount: o.offerEndAmount,
    },
    consideration: {
      itemType: o.considerationItemType,
      token: o.considerationToken,
      identifier: o.considerationIdentifier,
      startAmount: o.considerationStartAmount,
      endAmount: o.considerationEndAmount,
      recipient: o.considerationRecipient,
    },
    startTime: o.startTime.toString(),
    endTime: o.endTime.toString(),
    status: o.status,
    fulfiller: o.fulfiller,
    nftContract: o.nftContract,
    nftTokenId: o.nftTokenId,
    price: {
      raw: o.priceRaw,
      formatted: o.priceFormatted,
      currency: o.currencySymbol,
      decimals: CURRENCY_DECIMALS[(o.currencySymbol ?? "").toUpperCase()] ?? 18,
    },
    txHash: {
      created: o.createdTxHash,
      fulfilled: o.fulfilledTxHash,
      cancelled: o.cancelledTxHash,
    },
    createdBlockNumber: o.createdBlockNumber.toString(),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    token: tokenData !== undefined
      ? {
          name: tokenData?.name ?? null,
          image: tokenData?.image ?? null,
          description: tokenData?.description ?? null,
        }
      : null,
  };
}
