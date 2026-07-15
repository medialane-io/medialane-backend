import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import { parseSingleChain, parseChainFilter } from "../utils/chainFilter.js";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { buildOfferListWhere, buildProposalListWhere, buildLicenseListWhere } from "./sponsorship.filters.js";
import type { SponsorshipOffer, SponsorshipBid, SponsorshipProposal, SponsorshipLicense } from "@prisma/client";

const sponsorship = new Hono<AppEnv>();

/** licenseTermsUri/duration/etc are already JSON-safe; only Date fields need ISO stringifying, which c.json() handles natively — no BigInt fields on any of these four models. */
function serializeOffer(o: SponsorshipOffer) {
  return o;
}
function serializeBid(b: SponsorshipBid) {
  return b;
}
function serializeProposal(p: SponsorshipProposal) {
  return p;
}
function serializeLicense(l: SponsorshipLicense) {
  return l;
}

function parsePage(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 24)));
  return { page, limit };
}

// GET /v1/sponsorship/offers — ?nftContract=, ?author=, ?open=true|false, ?chain=, ?page, ?limit
sponsorship.get("/offers", publicCache(15), async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const { page, limit } = parsePage(c);
  const openRaw = c.req.query("open");
  const where = buildOfferListWhere({
    chainFilter,
    nftContract: c.req.query("nftContract") ?? undefined,
    author: c.req.query("author") ?? undefined,
    open: openRaw === undefined ? undefined : openRaw === "true",
  });
  const [rows, total] = await Promise.all([
    prisma.sponsorshipOffer.findMany({ where, orderBy: { createdAtChain: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.sponsorshipOffer.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeOffer), meta: { page, limit, total } });
});

// GET /v1/sponsorship/offers/:offerId — single, by (chain, offerId)
sponsorship.get("/offers/:offerId", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const offer = await prisma.sponsorshipOffer.findFirst({ where: { chain, offerId: c.req.param("offerId") } });
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  return c.json({ data: serializeOffer(offer) });
});

// GET /v1/sponsorship/offers/:offerId/bids — standing bids on an offer
sponsorship.get("/offers/:offerId/bids", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const bids = await prisma.sponsorshipBid.findMany({
    where: { chain, offerId: c.req.param("offerId") },
    orderBy: { placedAtChain: "desc" },
  });
  return c.json({ data: bids.map(serializeBid) });
});

// GET /v1/sponsorship/proposals — ?nftContract=, ?proposer=, ?open=true|false, ?chain=, ?page, ?limit
sponsorship.get("/proposals", publicCache(15), async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const { page, limit } = parsePage(c);
  const openRaw = c.req.query("open");
  const where = buildProposalListWhere({
    chainFilter,
    nftContract: c.req.query("nftContract") ?? undefined,
    proposer: c.req.query("proposer") ?? undefined,
    open: openRaw === undefined ? undefined : openRaw === "true",
  });
  const [rows, total] = await Promise.all([
    prisma.sponsorshipProposal.findMany({ where, orderBy: { createdAtChain: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.sponsorshipProposal.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeProposal), meta: { page, limit, total } });
});

// GET /v1/sponsorship/proposals/:proposalId — single, by (chain, proposalId)
sponsorship.get("/proposals/:proposalId", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const proposal = await prisma.sponsorshipProposal.findFirst({ where: { chain, proposalId: c.req.param("proposalId") } });
  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  return c.json({ data: serializeProposal(proposal) });
});

// GET /v1/sponsorship/licenses — ?holder=, ?author=, ?assetContract=, ?assetTokenId=, ?chain=, ?page, ?limit
// `holder` filters by CURRENT owner (TokenBalance — the license is a standard
// transferable ERC-721, so ownership is not on SponsorshipLicense itself).
sponsorship.get("/licenses", publicCache(15), async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const { page, limit } = parsePage(c);
  const holderRaw = c.req.query("holder");

  let tokenIdFilter: { in: string[] } | undefined;
  if (holderRaw) {
    const chain = chainFilter === "all" ? "STARKNET" : chainFilter.chain;
    const holder = normalizeAddress(chain, holderRaw);
    const held = await prisma.tokenBalance.findMany({
      where: { chain, owner: holder, amount: { not: "0" } },
      select: { tokenId: true },
    });
    tokenIdFilter = { in: held.map((t) => t.tokenId) };
  }

  const where = {
    ...buildLicenseListWhere({
      chainFilter,
      author: c.req.query("author") ?? undefined,
      assetContract: c.req.query("assetContract") ?? undefined,
      assetTokenId: c.req.query("assetTokenId") ?? undefined,
    }),
    ...(tokenIdFilter ? { tokenId: tokenIdFilter } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.sponsorshipLicense.findMany({ where, orderBy: { mintedAtChain: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.sponsorshipLicense.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeLicense), meta: { page, limit, total } });
});

// GET /v1/sponsorship/licenses/:tokenId — single, by (chain, tokenId), + current holder
sponsorship.get("/licenses/:tokenId", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const tokenId = c.req.param("tokenId");
  const license = await prisma.sponsorshipLicense.findFirst({ where: { chain, tokenId } });
  if (!license) return c.json({ error: "License not found" }, 404);

  const holderRow = await prisma.tokenBalance.findFirst({
    where: { chain, contractAddress: license.contractAddress, tokenId, amount: { not: "0" } },
    select: { owner: true },
  });
  return c.json({ data: { ...serializeLicense(license), currentHolder: holderRow?.owner ?? null } });
});

export default sponsorship;
