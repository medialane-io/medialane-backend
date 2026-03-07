import { Hono } from "hono";
import prisma from "../../db/client.js";

const stats = new Hono();

// GET /v1/stats — platform-wide aggregate numbers (publicly cached)
stats.get("/", async (c) => {
  const [collections, tokens, sales] = await Promise.all([
    prisma.collection.count({ where: { chain: "STARKNET" } }),
    prisma.token.count({ where: { chain: "STARKNET" } }),
    prisma.order.count({ where: { status: "FULFILLED" } }),
  ]);

  return c.json({ data: { collections, tokens, sales } });
});

export default stats;
