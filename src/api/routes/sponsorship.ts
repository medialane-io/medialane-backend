import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:sponsorship");

const sponsorship = new Hono<AppEnv>();

// GET /v1/sponsorship/offers
// Filters: ?nftContract=, ?author=, ?status=open|closed. Page/limit clamped
// the same way as GET /v1/collections.
sponsorship.get("/offers", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const nftContract = c.req.query("nftContract");
  const author = c.req.query("author");
  const status = c.req.query("status");

  const where = {
    chain: "STARKNET" as const,
    ...(nftContract ? { nftContract: normalizeAddress("STARKNET", nftContract) } : {}),
    ...(author ? { author: normalizeAddress("STARKNET", author) } : {}),
    ...(status === "open" ? { open: true } : status === "closed" ? { open: false } : {}),
  };

  const [data, total] = await Promise.all([
    prisma.sponsorshipOffer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.sponsorshipOffer.count({ where }),
  ]);

  return c.json({ data, meta: { page, limit, total } });
});

// GET /v1/sponsorship/offers/:offerId
sponsorship.get("/offers/:offerId", async (c) => {
  const offerId = c.req.param("offerId");

  const offer = await prisma.sponsorshipOffer.findFirst({
    where: { chain: "STARKNET", offerId },
    orderBy: { createdAt: "desc" },
  });

  if (!offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  return c.json({ data: offer });
});

// GET /v1/sponsorship/offers/:offerId/bids
sponsorship.get("/offers/:offerId/bids", async (c) => {
  const offerId = c.req.param("offerId");

  const bids = await prisma.sponsorshipBid.findMany({
    where: { chain: "STARKNET", offerId },
    orderBy: { updatedAt: "desc" },
  });

  return c.json({ data: bids });
});

export default sponsorship;
