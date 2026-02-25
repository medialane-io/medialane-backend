import { Hono } from "hono";
import prisma from "../../db/client.js";

const search = new Hono();

// GET /v1/search?q=...
search.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return c.json({ error: "q must be at least 2 characters" }, 400);
  }

  const limit = Math.min(Number(c.req.query("limit") ?? 10), 50);
  const pattern = `%${q}%`;

  const [tokens, collections] = await Promise.all([
    prisma.token.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          { contractAddress: { contains: q, mode: "insensitive" } },
          { tokenId: { contains: q } },
        ],
      },
      take: limit,
      select: {
        contractAddress: true,
        tokenId: true,
        name: true,
        image: true,
        owner: true,
        metadataStatus: true,
      },
    }),
    prisma.collection.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { contractAddress: { contains: q, mode: "insensitive" } },
        ],
      },
      take: limit,
      select: {
        contractAddress: true,
        name: true,
        totalSupply: true,
        floorPrice: true,
        holderCount: true,
      },
    }),
  ]);

  return c.json({
    data: {
      tokens,
      collections,
    },
    query: q,
  });
});

export default search;
