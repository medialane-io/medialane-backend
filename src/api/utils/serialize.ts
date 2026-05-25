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

export function serializeToken(
  token: any,
  activeOrders: any[],
  balances?: Array<{ owner: string; amount: string }>
) {
  return {
    id: token.id,
    chain: token.chain,
    contractAddress: token.contractAddress,
    tokenId: token.tokenId,
    owner: token.owner ?? null,
    tokenUri: token.tokenUri,
    metadataStatus: token.metadataStatus,
    standard: (token.collection?.standard ?? null) as "ERC721" | "ERC1155" | null,
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
    balances: balances ?? null,
    activeOrders: activeOrders.map((o) => serializeOrder(o)),
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

/**
 * Compute `hasActiveCounterOffer` for a set of orders in one DB query.
 *
 * Counter-offers are child orders that carry `parentOrderHash` pointing at
 * the original bid. The parent bid's `status` stays `ACTIVE` even while
 * a counter is outstanding — the relationship lives in the join, not in
 * a third lifecycle state (audit P0-1; `01-core-model §V`).
 *
 * Returns a Set of bid `orderHash` values that have ≥1 active child counter.
 * Pass the result through to `serializeOrder` per row so the UI can render
 * the "this bid has a counter outstanding" affordance.
 */
export async function counterOfferFlags(
  prisma: import("@prisma/client").PrismaClient,
  orders: { orderHash: string; offerItemType?: string | null }[],
): Promise<Set<string>> {
  // Only ERC-20 offers (bids) can be countered — keeps the IN list small.
  const bidHashes = orders
    .filter((o) => o.offerItemType === "ERC20")
    .map((o) => o.orderHash);
  if (bidHashes.length === 0) return new Set();
  const rows = await prisma.order.findMany({
    where: {
      parentOrderHash: { in: bidHashes },
      status: "ACTIVE",
    },
    select: { parentOrderHash: true },
  });
  return new Set(rows.flatMap((r) => (r.parentOrderHash ? [r.parentOrderHash] : [])));
}

export function serializeOrder(
  o: any,
  tokenData?: { name: string | null; image: string | null; description: string | null } | null,
  hasActiveCounterOffer?: boolean,
) {
  return {
    id: o.id,
    chain: o.chain,
    orderHash: o.orderHash,
    /** Counter-offers point at their parent bid via this field. Null for top-level orders. */
    parentOrderHash: o.parentOrderHash ?? null,
    /** Set by `/v1/orders/user/:address` (and any list endpoint that opts in) — true when
     *  this is an ERC-20 bid AND at least one ACTIVE counter exists with parentOrderHash = orderHash.
     *  The frontend uses this to render the "your bid was countered" affordance without depending
     *  on a `COUNTER_OFFERED` status (audit P0-1). Undefined on endpoints that don't compute it. */
    hasActiveCounterOffer: hasActiveCounterOffer ?? undefined,
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
    remainingAmount: o.remainingAmount ?? null,
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
