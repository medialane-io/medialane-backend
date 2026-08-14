import prisma from "../../db/client.js";
import type { Chain, Collection, Order, Token, TokenStandard } from "@prisma/client";
import type { RawCollectionRow, RawOrderRow, RawTokenRow } from "./rawTypes.js";

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

export function composeAmountDisplay(
  value: string | null | undefined,
  currency: string | null | undefined
): string | null {
  if (value == null || value === "") return null;
  return currency ? `${value} ${currency}` : value;
}

export async function batchTokenMeta(
  orders: { chain: import("@prisma/client").Chain; nftContract: string | null; nftTokenId: string | null }[]
): Promise<Map<string, { name: string | null; image: string | null; description: string | null; animationUrl: string | null }>> {
  const pairs = orders
    .filter((o) => o.nftContract && o.nftTokenId)
    .map((o) => ({ chain: o.chain, contractAddress: o.nftContract!, tokenId: o.nftTokenId! }));

  if (!pairs.length) return new Map();

  const tokens = await prisma.token.findMany({
    where: { OR: pairs },
    select: { contractAddress: true, tokenId: true, name: true, image: true, description: true, animationUrl: true },
  });

  return new Map(
    tokens.map((t) => [
      `${t.contractAddress}-${t.tokenId}`,
      { name: t.name, image: t.image, description: t.description, animationUrl: t.animationUrl },
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

export function serializeCollection(
  c: (Collection | RawCollectionRow) & { profile?: SerializableCollectionProfile }
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
    image: c.image,
    owner: c.owner ?? null,
    startBlock: c.startBlock.toString(),
    metadataStatus: c.metadataStatus,
    standard: c.standard,
    isFeatured: c.isFeatured,
    isHidden: c.isHidden,
    service: c.service ?? null,
    claimedBy: c.claimedBy ?? null,
    floorPrice: composeAmountDisplay(c.floorPrice, c.floorCurrency),
    totalVolume: composeAmountDisplay(c.totalVolume, c.volumeCurrency),
    holderCount: c.holderCount,
    totalSupply: c.totalSupply,
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

export function serializeToken(
  token: SerializableToken,
  activeOrders: SerializableOrder[],
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
      animationUrl: token.animationUrl,
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
  tokenData?: { name: string | null; image: string | null; description: string | null; animationUrl: string | null } | null,
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
          description: tokenData?.description ?? null,
          animationUrl: tokenData?.animationUrl ?? null,
        }
      : null,
  };
}

export function serializeCreatorProfile(
  profile: {
    username: string | null;
    displayName: string | null;
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
    displayName: profile.displayName,
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
