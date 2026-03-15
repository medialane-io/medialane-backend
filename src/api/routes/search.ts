import { Hono } from "hono";
import prisma from "../../db/client.js";
import type { RawSearchTokenRow, RawSearchCollectionRow } from "../utils/rawTypes.js";

const search = new Hono();

// GET /v1/search?q=...
search.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return c.json({ error: "q must be at least 2 characters" }, 400);
  }

  const limit = Math.min(Number(c.req.query("limit") ?? 10), 50);

  const [tokenRows, collectionRows] = await Promise.all([
    prisma.$queryRaw<RawSearchTokenRow[]>`
      SELECT "contractAddress", "tokenId", name, image, owner, "metadataStatus",
             ts_rank(
               to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || "contractAddress" || ' ' || "tokenId"),
               plainto_tsquery('english', ${q})
             ) AS rank
      FROM "Token"
      WHERE chain = 'STARKNET'
        AND "isHidden" = false
        AND to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || "contractAddress" || ' ' || "tokenId")
            @@ plainto_tsquery('english', ${q})
      ORDER BY rank DESC
      LIMIT ${limit}
    `,
    prisma.$queryRaw<RawSearchCollectionRow[]>`
      SELECT "contractAddress", name, image, "totalSupply", "floorPrice", "holderCount", "collectionId",
             ts_rank(
               to_tsvector('english', coalesce(name,'') || ' ' || "contractAddress"),
               plainto_tsquery('english', ${q})
             ) AS rank
      FROM "Collection"
      WHERE chain = 'STARKNET'
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
  ]);

  // Strip rank field before returning
  const tokens = tokenRows.map(({ rank: _rank, ...rest }) => rest);
  const collections = collectionRows.map(({ rank: _rank, ...rest }) => rest);

  return c.json({
    data: {
      tokens,
      collections,
    },
    query: q,
  });
});

export default search;
