import prisma from "../../db/client.js";
import { Prisma, type Chain, type Collection, type Order, type Token, type TokenStandard } from "@prisma/client";
import type { RawCollectionRow, RawOrderRow, RawTokenRow } from "./rawTypes.js";
import { batchCollectionStats, type CollectionStats } from "./collectionStats.js";
import type { LiveMetadata } from "./liveMetadata.js";

export type SerializableOrder = Order | RawOrderRow;

export type SerializableToken = (Token | RawTokenRow) & {
  collection?: { standard: TokenStandard | null } | null;
  owner?: string | null;
};

const CURRENCY_DECIMALS: Record<string, number> = {
  USDC: 6,
  "USDC.E": 6,
  USDT: 6,
  ETH: 18,
  STRK: 18,
  WBTC: 8,
};

export async function batchTokenMeta(
  orders: { chain: import("@prisma/client").Chain; nftContract: string | null; nftTokenId: string | null }[]
): Promise<Map<string, { name: string | null; image: string | null; animationUrl: string | null }>> {
  const pairs = orders
    .filter((o) => o.nftContract && o.nftTokenId)
    .map((o) => ({ chain: o.chain, contractAddress: o.nftContract!, tokenId: o.nftTokenId! }));

  if (!pairs.length) return new Map();

  const tokens = await prisma.token.findMany({
    where: { OR: pairs },
    select: { contractAddress: true, tokenId: true, name: true, image: true, animationUrl: true },
  });

  return new Map(
    tokens.map((t) => [
      `${t.contractAddress}-${t.tokenId}`,
      { name: t.name, image: t.image, animationUrl: t.animationUrl },
    ])
  );
}

export async function batchOrdersByToken(
  tokens: { chain: Chain; contractAddress: string; tokenId: string }[],
  deps: { order: Pick<typeof prisma.order, "findMany"> } = { order: prisma.order },
): Promise<Map<string, Order[]>> {
  if (tokens.length === 0) return new Map();

  const orders = await deps.order.findMany({
    where: {
      status: "ACTIVE",
      OR: tokens.map((t) => ({ chain: t.chain, nftContract: t.contractAddress, nftTokenId: t.tokenId })),
    },
  });

  const byToken = new Map<string, Order[]>();
  for (const order of orders) {
    const key = `${order.nftContract}:${order.nftTokenId}`;
    const existing = byToken.get(key) ?? [];
    existing.push(order);
    byToken.set(key, existing);
  }
  return byToken;
}

type SerializableCollectionProfile = {
  hasGatedContent: boolean;
  gatedContentTitle: string | null;
  slug: string | null;
  image: string | null;
  displayName: string | null;
  description: string | null;
} | null;

export async function batchFallbackImages(
  collections: { chain: Chain; contractAddress: string; image: string | null }[],
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<Map<string, string>> {
  const missing = collections.filter((c) => !c.image);
  if (missing.length === 0) return new Map();
  const keys = missing.map((c) => Prisma.sql`(${c.chain}::"Chain", ${c.contractAddress})`);
  const rows = await db.$queryRaw<{ contractAddress: string; image: string }[]>`
    SELECT DISTINCT ON (chain, "contractAddress") "contractAddress", image
    FROM "Token"
    WHERE (chain, "contractAddress") IN (${Prisma.join(keys)})
      AND "metadataStatus" = 'FETCHED' AND image IS NOT NULL AND "isHidden" = false
    ORDER BY chain, "contractAddress", "tokenId" ASC
  `;
  return new Map(rows.map((r) => [r.contractAddress, r.image]));
}

export function serializeCollection(
  c: (Collection | RawCollectionRow) & { profile?: SerializableCollectionProfile },
  stats: CollectionStats | undefined,
  fallbackImage?: string | null,
) {
  const profile = c.profile ?? null;
  return {
    id: c.id,
    chain: c.chain,
    contractAddress: c.contractAddress,
    collectionId: c.collectionId ?? null,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    image: c.image ?? fallbackImage ?? null,
    attributes: c.attributes ?? null,
    owner: c.owner ?? null,
    startBlock: c.startBlock.toString(),
    metadataStatus: c.metadataStatus,
    standard: c.standard,
    isFeatured: c.isFeatured,
    isHidden: c.isHidden,
    service: c.service ?? null,
    claimedBy: c.claimedBy ?? null,
    floorPrice: stats?.floorPrice ?? null,
    totalVolume: stats?.totalVolume ?? null,
    holderCount: stats?.holderCount ?? 0,
    totalSupply: stats?.totalSupply ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    profile: profile
      ? {
          hasGatedContent: profile.hasGatedContent,
          gatedContentTitle: profile.gatedContentTitle ?? null,
          slug: profile.slug ?? null,
          image: profile.image ?? null,
          displayName: profile.displayName ?? null,
          description: profile.description ?? null,
        }
      : null,
  };
}

export async function serializeCollections<T extends (Collection | RawCollectionRow) & { profile?: SerializableCollectionProfile }>(
  rows: T[],
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
) {
  const [fallbacks, stats] = await Promise.all([batchFallbackImages(rows, db), batchCollectionStats(rows, db)]);
  return rows.map((row) => serializeCollection(row, stats.get(row.contractAddress), fallbacks.get(row.contractAddress)));
}

export function serializeToken(
  token: SerializableToken,
  activeOrders: SerializableOrder[],
  balances?: Array<{ owner: string; amount: string }>,
  live: Partial<LiveMetadata> = {},
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
      description: live.description ?? null,
      image: token.image,
      animationUrl: token.animationUrl,
      attributes: token.attributes,
      ipType: token.ipType,
      licenseType: token.licenseType,
      commercialUse: token.commercialUse,
      author: token.author,
      externalUrl: live.externalUrl ?? null,
    },
    balances: balances ?? null,
    activeOrders: activeOrders.map((o) => serializeOrder(o)),
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

export async function counterOfferFlags(
  prisma: import("@prisma/client").PrismaClient,
  orders: { orderHash: string; offerItemType?: string | null }[],
): Promise<Set<string>> {

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
  o: SerializableOrder,
  tokenData?: { name: string | null; image: string | null; animationUrl: string | null } | null,
  hasActiveCounterOffer?: boolean,
) {
  return {
    id: o.id,
    chain: o.chain,
    orderHash: o.orderHash,

    parentOrderHash: o.parentOrderHash ?? null,

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
          description: null,
          animationUrl: tokenData?.animationUrl ?? null,
        }
      : null,
  };
}

export function serializeCreatorProfile(
  profile: {
    username: string | null;
    name: string | null;
    bio: string | null;
    avatarImage: string | null;
    websiteUrl: string | null;
    twitterUrl: string | null;
    discordUrl: string | null;
    telegramUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  walletAddress: string,
) {
  return {
    walletAddress,
    username: profile.username,
    name: profile.name,
    bio: profile.bio,
    avatarImage: profile.avatarImage,
    websiteUrl: profile.websiteUrl,
    twitterUrl: profile.twitterUrl,
    discordUrl: profile.discordUrl,
    telegramUrl: profile.telegramUrl,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
