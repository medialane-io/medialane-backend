import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import { chainWhere, parseChainFilter } from "../utils/chainFilter.js";
import prisma from "../../db/client.js";

const stats = new Hono();

// The three counts scan large tables and the numbers move slowly — hold one
// shared result per chain filter for CACHE_MS so N callers cost one query
// set, not N.
const CACHE_MS = 30_000;
type StatsData = { collections: number; tokens: number; sales: number };
const cached = new Map<string, { data: StatsData; at: number }>();

// GET /v1/stats — platform-wide aggregate numbers (shared micro-cache + HTTP cache)
stats.get("/", publicCache(60), async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
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
