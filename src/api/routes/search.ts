import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import prisma from "../../db/client.js";
import type { RawSearchTokenRow, RawSearchCollectionRow } from "../utils/rawTypes.js";
import { composeAmountDisplay } from "../utils/serialize.js";
import { parseSingleChain } from "../utils/chainFilter.js";

const search = new Hono();

// GET /v1/search?q=...
search.get("/", publicCache(60), async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return c.json({ error: "q must be at least 2 characters" }, 400);
  }

  const limitParam = Number(c.req.query("limit") ?? 10);
  const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10, 50);
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);

  const [tokenRows, collectionRows, creatorRows] = await Promise.all([
    prisma.$queryRaw<RawSearchTokenRow[]>`
      SELECT "contractAddress", "tokenId", name, image, "metadataStatus",
             ts_rank(
               to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || "contractAddress" || ' ' || "tokenId"),
               plainto_tsquery('english', ${q})
             ) AS rank
      FROM "Token"
      WHERE chain = ${chain}::"Chain"
        AND "isHidden" = false
        AND "contractAddress" NOT IN (SELECT "contractAddress" FROM "Collection" WHERE "isHidden" = true)
        AND to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || "contractAddress" || ' ' || "tokenId")
            @@ plainto_tsquery('english', ${q})
      ORDER BY rank DESC
      LIMIT ${limit}
    `,
    prisma.$queryRaw<RawSearchCollectionRow[]>`
      SELECT "contractAddress", name, image, "totalSupply", "floorPrice", "floorCurrency", "holderCount", "collectionId",
             ts_rank(
               to_tsvector('english', coalesce(name,'') || ' ' || "contractAddress"),
               plainto_tsquery('english', ${q})
             ) AS rank
      FROM "Collection"
      WHERE chain = ${chain}::"Chain"
        AND "isHidden" = false
        AND "contractAddress" NOT IN (
          SELECT c."contractAddress" FROM "Collection" c
          INNER JOIN "HiddenCreator" hc ON hc.address = c.owner AND hc.chain::text = c.chain::text
        )
        AND to_tsvector('english', coalesce(name,'') || ' ' || "contractAddress")
            @@ plainto_tsquery('english', ${q})
      ORDER BY rank DESC
      LIMIT ${limit}
    `,
    prisma.$queryRaw<{ walletAddress: string; username: string | null; displayName: string | null; bio: string | null; avatarImage: string | null }[]>`
      SELECT w.address AS "walletAddress", ap.username, ap."displayName", ap.bio, ap."avatarImage"
      FROM "AccountProfile" ap
      JOIN "Identity" w ON w."accountId" = ap."accountId" AND w.scheme = 'wallet' AND w."isPrimary" = true
      WHERE ap.username IS NOT NULL
        AND (
          ap.username ILIKE ${'%' + q.replace(/[%_\\]/g, (ch) => `\\${ch}`) + '%'} ESCAPE '\\'
          OR ap."displayName" ILIKE ${'%' + q.replace(/[%_\\]/g, (ch) => `\\${ch}`) + '%'} ESCAPE '\\'
        )
      LIMIT ${limit}
    `,
  ]);

  // Strip rank; compose floorPrice into the API display shape (value + currency
  // live in separate columns so numeric sorts stay valid SQL).
  const tokens = tokenRows.map(({ rank: _rank, ...rest }) => rest);
  const collections = collectionRows.map(({ rank: _rank, floorCurrency, ...rest }) => ({
    ...rest,
    floorPrice: composeAmountDisplay(rest.floorPrice, floorCurrency),
  }));

  return c.json({
    data: {
      tokens,
      collections,
      creators: creatorRows,
    },
    query: q,
  });
});

export default search;
