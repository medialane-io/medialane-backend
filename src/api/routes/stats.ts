import { Hono } from "hono";
import { chainWhere } from "../utils/chainFilter.js";
import prisma from "../../db/client.js";
import { chainFilterScope } from "../http/chain.js";

const stats = new Hono();

const CACHE_MS = 30_000;
type StatsData = { collections: number; tokens: number; sales: number };
const cached = new Map<string, { data: StatsData; at: number }>();

stats.get("/", chainFilterScope(), async (c) => {
  const chainFilter = c.get("chainFilter");
  const cacheKey = chainFilter === "all" ? "all" : chainFilter.chain;

  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return c.json({ data: hit.data });
  }

  const where = chainWhere(chainFilter);
  const [collections, tokens, sales] = await Promise.all([
    prisma.collection.count({ where }),
    prisma.token.count({ where }),
    prisma.orderFill.count({ where }),
  ]);

  const data: StatsData = { collections, tokens, sales };
  cached.set(cacheKey, { data, at: Date.now() });
  return c.json({ data });
});

export default stats;
