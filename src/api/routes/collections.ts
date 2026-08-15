import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import { z } from "zod";
import { Prisma, type Collection } from "@prisma/client";
import { chainWhere, parseChainFilter, parseSingleChain } from "../utils/chainFilter.js";
import type { RawCollectionRow, RawCountRow, RawTokenRow } from "../utils/rawTypes.js";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/adminSecretAuth.js";
import { env } from "../../config/env.js";
import { serializeToken, serializeCollection } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { num as starkNum } from "starknet";
import { STARKNET_COLLECTION_721_CONTRACT, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { resolveCollectionCreated, decodeCollectionCreatedEvent } from "../../mirror/handlers/collectionCreated.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { callRpc } from "../../utils/starknet.js";
import { parseStandardFilter } from "./collections.standardFilter.js";
import { registerCollectionSyncRoutes } from "./collections-sync.js";

const log = createLogger("routes:collections");

const collections = new Hono();

const COLLECTION_SORT_VALUES = ["recent", "supply", "floor", "volume", "name"] as const;
type CollectionSort = (typeof COLLECTION_SORT_VALUES)[number];

collections.get("/", publicCache(30), async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const isFeatured   = c.req.query("isFeatured") ?? c.req.query("isKnown");
  const owner     = c.req.query("owner");
  const service   = c.req.query("service");
  const standardFilter = parseStandardFilter(c.req.query("standard"));
  const hideEmpty = c.req.query("hideEmpty") === "true";
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const sortRaw = c.req.query("sort") ?? "recent";
  const sort: CollectionSort = (COLLECTION_SORT_VALUES as readonly string[]).includes(sortRaw)
    ? (sortRaw as CollectionSort)
    : "recent";

  const skip = (page - 1) * limit;

  if (sort === "floor" || sort === "volume") {
    const conditions: Prisma.Sql[] = [Prisma.sql`"isHidden" = false`];
    if (chainFilter !== "all") conditions.push(Prisma.sql`chain = ${chainFilter.chain}::"Chain"`);
    if (isFeatured === "true")  conditions.push(Prisma.sql`"isFeatured" = true`);
    if (isFeatured === "false") conditions.push(Prisma.sql`"isFeatured" = false`);
    if (owner) {
      if (chainFilter === "all") return c.json({ error: "owner filter requires a single chain" }, 400);
      conditions.push(Prisma.sql`owner = ${normalizeAddress(chainFilter.chain, owner)}`);
    }
    if (service)   conditions.push(Prisma.sql`service = ${service}`);
    if (standardFilter) {

      const casted = standardFilter.map((s) => Prisma.sql`${s}::"TokenStandard"`);
      conditions.push(Prisma.sql`standard IN (${Prisma.join(casted)})`);
    }
    if (hideEmpty) conditions.push(Prisma.sql`"totalSupply" > 0`);
    const whereClause = Prisma.join(conditions, " AND ");

    const orderExpr = sort === "floor"
      ? Prisma.sql`("floorCurrency" = 'USDC') DESC NULLS LAST, "floorCurrency" ASC NULLS LAST, "floorPrice"::numeric ASC NULLS LAST`
      : Prisma.sql`("volumeCurrency" = 'USDC') DESC NULLS LAST, "volumeCurrency" ASC NULLS LAST, "totalVolume"::numeric DESC NULLS LAST`;

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<RawCollectionRow[]>`
        SELECT * FROM "Collection"
        WHERE ${whereClause}
        ORDER BY ${orderExpr}
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<RawCountRow[]>`
        SELECT COUNT(*) AS count FROM "Collection" WHERE ${whereClause}
      `,
    ]);

    return c.json({
      data:  data.map(serializeCollection),
      meta:  { page, limit, total: Number(rawTotal[0].count) },
    });
  }

  const where: any = { ...chainWhere(chainFilter), isHidden: false };
  if (isFeatured === "true")  where.isFeatured = true;
  if (isFeatured === "false") where.isFeatured = false;
  if (owner) {
    if (chainFilter === "all") return c.json({ error: "owner filter requires a single chain" }, 400);
    where.owner = normalizeAddress(chainFilter.chain, owner);
  }
  if (service)   where.service = service;
  if (standardFilter) where.standard = { in: standardFilter };
  if (hideEmpty) where.totalSupply = { gt: 0 };

  const orderBy =
    sort === "supply" ? { totalSupply: "desc" as const } :
    sort === "name"   ? { name: "asc"  as const }        :
                        { createdAt: "desc" as const };

  const [data, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        profile: {

          select: { hasGatedContent: true, gatedContentTitle: true, slug: true, image: true, displayName: true, description: true },
        },
      },
    }),
    prisma.collection.count({ where }),
  ]);

  return c.json({ data: data.map(serializeCollection), meta: { page, limit, total } });
});

collections.get("/by-slug/:slug", publicCache(60), async (c) => {
  const slug = c.req.param("slug").toLowerCase().trim();

  const profile = await prisma.collectionProfile.findUnique({
    where: { slug },
    select: { contractAddress: true, chain: true },
  });

  if (!profile) return c.json({ error: "Collection not found" }, 404);

  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: profile.chain, contractAddress: profile.contractAddress } },
    include: {
      profile: {
        select: {
          id: true,
          contractAddress: true,
          chain: true,
          displayName: true,
          description: true,
          image: true,
          bannerImage: true,
          websiteUrl: true,
          twitterUrl: true,
          discordUrl: true,
          telegramUrl: true,
          gatedContentTitle: true,
          hasGatedContent: true,
          slug: true,
          updatedBy: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!col || col.deletedAt) return c.json({ error: "Collection not found" }, 404);

  return c.json({ data: { ...serializeCollection(col), profile: col.profile } });
});

collections.get("/:contract", publicCache(30), async (c) => {
  const { contract } = c.req.param();
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const include = c.req.query("include");
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress: normalizeAddress(chain, contract) } },
    ...(include === "profile" ? { include: { profile: true } } : {}),
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);

  let profileData: Record<string, unknown> | null = null;
  if (include === "profile") {
    const profile = (col as any).profile ?? null;
    if (profile) {

      const { gatedContentUrl: _url, gatedContentType: _type, ...safeProfile } = profile;
      profileData = safeProfile;
    }
  }

  return c.json({
    data: {
      ...serializeCollection(col),
      ...(include === "profile" ? { profile: profileData } : {}),
    },
  });
});

collections.get("/:contract/tokens", publicCache(30), async (c) => {
  const { contract } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const sortParam = c.req.query("sort");
  const sort: "recent" | "oldest" | "name" | "price" =
    sortParam === "oldest" || sortParam === "name" || sortParam === "price"
      ? sortParam
      : "recent";
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const addr = normalizeAddress(chain, contract);

  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress: addr } },
  });

  if (collection) {
    const hiddenCreator = await prisma.hiddenCreator.findUnique({
      where: {
        chain_address: {
          chain: collection.chain,
          address: collection.owner ?? "",
        },
      },
    });
    if (hiddenCreator) {
      return c.json({ data: [], meta: { page, limit, total: 0 } });
    }
  }

  const skip = (page - 1) * limit;

  if (sort === "price") {
    const [data, total] = await Promise.all([
      prisma.$queryRaw<RawTokenRow[]>`
        SELECT t.*,
          (
            SELECT MIN(o."priceRaw"::numeric)
            FROM "Order" o
            WHERE o.chain = ${chain}::"Chain"
              AND o."nftContract" = t."contractAddress"
              AND o."nftTokenId" = t."tokenId"
              AND o.status = 'ACTIVE'::"OrderStatus"
              AND o."offerItemType" IN ('ERC721', 'ERC1155')
          ) AS "minPrice"
        FROM "Token" t
        WHERE t.chain = ${chain}::"Chain" AND t."contractAddress" = ${addr} AND t."isHidden" = false AND t."metadataStatus" = 'FETCHED'
        ORDER BY "minPrice"::numeric ASC NULLS LAST
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.token.count({ where: { chain, contractAddress: addr, isHidden: false, metadataStatus: "FETCHED" } }),
    ]);

    const balancesByToken = await batchTokenBalances(chain, addr, data.map((t) => t.tokenId));
    return c.json({
      data: data.map((t) =>
        serializeToken(
          { ...t, collection: { standard: collection?.standard ?? null } },
          [],
          balancesByToken.get(t.tokenId) ?? []
        )
      ),
      meta: { page, limit, total },
    });
  }

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain, contractAddress: addr, isHidden: false, metadataStatus: "FETCHED" },
      orderBy:
        sort === "oldest"
          ? { createdAt: "asc" }
          : sort === "name"
            ? { name: "asc" }
            : { createdAt: "desc" },
      skip,
      take: limit,
      include: { collection: { select: { standard: true } } },
    }),
    prisma.token.count({ where: { chain, contractAddress: addr, isHidden: false, metadataStatus: "FETCHED" } }),
  ]);

  const balancesByToken = await batchTokenBalances(chain, addr, data.map((t) => t.tokenId));

  return c.json({
    data: data.map((t) => serializeToken(t, [], balancesByToken.get(t.tokenId) ?? [])),
    meta: { page, limit, total },
  });
});

async function batchTokenBalances(chain: import("@prisma/client").Chain, contractAddress: string, tokenIds: string[]) {
  const balanceRows = tokenIds.length
    ? await prisma.tokenBalance.findMany({
        where: {
          chain,
          contractAddress,
          tokenId: { in: tokenIds },
          amount: { not: "0" },
        },
        select: { tokenId: true, owner: true, amount: true },
      })
    : [];
  const balancesByToken = new Map<string, { owner: string; amount: string }[]>();
  for (const b of balanceRows) {
    const arr = balancesByToken.get(b.tokenId) ?? [];
    arr.push({ owner: b.owner, amount: b.amount });
    balancesByToken.set(b.tokenId, arr);
  }
  return balancesByToken;
}

registerCollectionSyncRoutes(collections);

export default collections;
