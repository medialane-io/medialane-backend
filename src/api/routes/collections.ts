import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Prisma, type Collection } from "@prisma/client";
import type { RawCountRow, RawTokenRow } from "../utils/rawTypes.js";
import prisma from "../../db/client.js";
import { env } from "../../config/env.js";
import { serializeToken, serializeCollections } from "../utils/serialize.js";
import { collectionHasTokens, collectionStatsJoin, collectionTotalSupply } from "../utils/collectionStats.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import { parseStandardFilter } from "./collections.standardFilter.js";
import { includeBalances } from "./collections.tokenBalances.js";
import { registerCollectionSyncRoutes } from "./collections-sync.js";
import { chainFilterScope, chainScope } from "../http/chain.js";
import { pageQuery } from "../http/page.js";

const log = createLogger("routes:collections");

const collections = new Hono();

const COLLECTION_SORT_VALUES = ["recent", "supply", "floor", "volume", "name"] as const;
type CollectionSort = (typeof COLLECTION_SORT_VALUES)[number];

collections.get("/", chainFilterScope(), zValidator("query", pageQuery()), async (c) => {
  const { page, limit } = c.req.valid("query");
  const isFeatured   = c.req.query("isFeatured") ?? c.req.query("isKnown");
  const owner     = c.req.query("owner");
  const service   = c.req.query("service");
  const standardFilter = parseStandardFilter(c.req.query("standard"));
  const hideEmpty = c.req.query("hideEmpty") === "true";
  const chainFilter = c.get("chainFilter");
  const sortRaw = c.req.query("sort") ?? "recent";
  const sort: CollectionSort = (COLLECTION_SORT_VALUES as readonly string[]).includes(sortRaw)
    ? (sortRaw as CollectionSort)
    : "recent";

  const skip = (page - 1) * limit;

  const conditions: Prisma.Sql[] = [Prisma.sql`c."isHidden" = false`];
  if (chainFilter !== "all") conditions.push(Prisma.sql`c.chain = ${chainFilter.chain}::"Chain"`);
  if (isFeatured === "true")  conditions.push(Prisma.sql`c."isFeatured" = true`);
  if (isFeatured === "false") conditions.push(Prisma.sql`c."isFeatured" = false`);
  if (owner) {
    if (chainFilter === "all") return c.json({ error: "owner filter requires a single chain" }, 400);
    conditions.push(Prisma.sql`c.owner = ${normalizeAddress(chainFilter.chain, owner)}`);
  }
  if (service)   conditions.push(Prisma.sql`c.service = ${service}`);
  if (standardFilter) {

    const casted = standardFilter.map((s) => Prisma.sql`${s}::"TokenStandard"`);
    conditions.push(Prisma.sql`c.standard IN (${Prisma.join(casted)})`);
  }
  if (hideEmpty) conditions.push(collectionHasTokens);
  const whereClause = Prisma.join(conditions, " AND ");

  const orderExpr =
    sort === "floor"  ? Prisma.sql`(fl."floorCurrency" = 'USDC') DESC NULLS LAST, fl."floorCurrency" ASC NULLS LAST, fl."floorRaw"::numeric ASC NULLS LAST` :
    sort === "volume" ? Prisma.sql`(vol."volumeCurrency" = 'USDC') DESC NULLS LAST, vol."volumeCurrency" ASC NULLS LAST, vol."volumeRaw"::numeric DESC NULLS LAST` :
    sort === "supply" ? Prisma.sql`${collectionTotalSupply} DESC` :
    sort === "name"   ? Prisma.sql`c.name ASC` :
                        Prisma.sql`c."createdAt" DESC`;
  const statsJoin = sort === "floor" || sort === "volume" || sort === "supply" ? collectionStatsJoin() : Prisma.empty;

  const [idRows, rawTotal] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM "Collection" c
      ${statsJoin}
      WHERE ${whereClause}
      ORDER BY ${orderExpr}, c.id
      LIMIT ${limit} OFFSET ${skip}
    `,
    prisma.$queryRaw<RawCountRow[]>`
      SELECT COUNT(*) AS count FROM "Collection" c WHERE ${whereClause}
    `,
  ]);

  const rows = await prisma.collection.findMany({
    where: { id: { in: idRows.map((r) => r.id) } },
    include: {
      profile: {

        select: { hasGatedContent: true, gatedContentTitle: true, slug: true, image: true, displayName: true, description: true },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const data = idRows.flatMap((r) => byId.get(r.id) ?? []);

  return c.json({ data: await serializeCollections(data), meta: { page, limit, total: Number(rawTotal[0].count) } });
});

collections.get("/by-slug/:slug", async (c) => {
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

  const [data] = await serializeCollections([col]);
  return c.json({ data: { ...data, profile: col.profile } });
});

collections.get("/:contract", chainScope(), async (c) => {
  const { contract } = c.req.param();
  const chain = c.get("chain");
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

  const [data] = await serializeCollections([col]);
  return c.json({
    data: {
      ...data,
      ...(include === "profile" ? { profile: profileData } : {}),
    },
  });
});

collections.get("/:contract/tokens", chainScope(), zValidator("query", pageQuery()), async (c) => {
  const { contract } = c.req.param();
  const { page, limit } = c.req.valid("query");
  const sortParam = c.req.query("sort");
  const sort: "recent" | "oldest" | "name" | "price" =
    sortParam === "oldest" || sortParam === "name" || sortParam === "price"
      ? sortParam
      : "recent";
  const chain = c.get("chain");
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
        WHERE t.chain = ${chain}::"Chain" AND t."contractAddress" = ${addr} AND t."isHidden" = false
        ORDER BY "minPrice"::numeric ASC NULLS LAST
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.token.count({ where: { chain, contractAddress: addr, isHidden: false } }),
    ]);

    const balancesByToken = includeBalances(collection?.standard) ? await batchTokenBalances(chain, addr, data.map((t) => t.tokenId)) : null;
    return c.json({
      data: data.map((t) =>
        serializeToken(
          { ...t, collection: { standard: collection?.standard ?? null } },
          [],
          balancesByToken ? balancesByToken.get(t.tokenId) ?? [] : undefined
        )
      ),
      meta: { page, limit, total },
    });
  }

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain, contractAddress: addr, isHidden: false },
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
    prisma.token.count({ where: { chain, contractAddress: addr, isHidden: false } }),
  ]);

  const balancesByToken = includeBalances(collection?.standard) ? await batchTokenBalances(chain, addr, data.map((t) => t.tokenId)) : null;

  return c.json({
    data: data.map((t) => serializeToken(t, [], balancesByToken ? balancesByToken.get(t.tokenId) ?? [] : undefined)),
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
