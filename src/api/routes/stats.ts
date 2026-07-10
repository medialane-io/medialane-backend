import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import prisma from "../../db/client.js";

const stats = new Hono();

// The three counts scan large tables and the numbers move slowly — hold one
// shared result for CACHE_MS so N callers cost one query set, not N.
const CACHE_MS = 30_000;
let cached: { data: { collections: number; tokens: number; sales: number }; at: number } | null = null;

// GET /v1/stats — platform-wide aggregate numbers (shared micro-cache + HTTP cache)
stats.get("/", publicCache(60), async (c) => {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return c.json({ data: cached.data });
  }

  const [collections, tokens, sales] = await Promise.all([
    prisma.collection.count({ where: { chain: "STARKNET" } }),
    prisma.token.count({ where: { chain: "STARKNET" } }),
    prisma.orderFill.count({ where: { chain: "STARKNET" } }),
  ]);

  cached = { data: { collections, tokens, sales }, at: Date.now() };
  return c.json({ data: cached.data });
});

export default stats;
