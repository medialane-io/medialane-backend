import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import { parseSingleChain, parseChainFilter } from "../utils/chainFilter.js";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { buildOfferListWhere, buildProposalListWhere, buildLicenseListWhere } from "./sponsorship.filters.js";
import type { SponsorshipOffer, SponsorshipBid, SponsorshipProposal, SponsorshipLicense, Chain } from "@prisma/client";

const sponsorship = new Hono<AppEnv>();

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

async function resolveOwnedPairs(chain: Chain, ownerRaw: string | undefined) {
  if (!ownerRaw) return undefined;
  const owner = normalizeAddress(chain, ownerRaw);
  const held = await prisma.tokenBalance.findMany({
    where: { chain, owner, amount: { not: "0" } },
    select: { contractAddress: true, tokenId: true },
  });
  return held.map((t) => ({ contractAddress: t.contractAddress, tokenId: t.tokenId }));
}

sponsorship.get("/offers", publicCache(15), async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const { page, limit } = parsePage(c);
  const openRaw = c.req.query("open");
  const addrChain = chainFilter === "all" ? "STARKNET" : chainFilter.chain;
  const ownedPairs = await resolveOwnedPairs(addrChain, c.req.query("owner") ?? undefined);
  const where = buildOfferListWhere({
    chainFilter,
    nftContract: c.req.query("nftContract") ?? undefined,
    author: c.req.query("author") ?? undefined,
    open: openRaw === undefined ? undefined : openRaw === "true",
    ownedPairs,
  });
  const [rows, total] = await Promise.all([
    prisma.sponsorshipOffer.findMany({ where, orderBy: { createdAtChain: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.sponsorshipOffer.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeOffer), meta: { page, limit, total } });
});

sponsorship.get("/offers/:offerId", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const offer = await prisma.sponsorshipOffer.findFirst({ where: { chain, offerId: c.req.param("offerId") } });
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  return c.json({ data: serializeOffer(offer) });
});

sponsorship.get("/offers/:offerId/bids", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const bids = await prisma.sponsorshipBid.findMany({
    where: { chain, offerId: c.req.param("offerId") },
    orderBy: { placedAtChain: "desc" },
  });
  return c.json({ data: bids.map(serializeBid) });
});

sponsorship.get("/proposals", publicCache(15), async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const { page, limit } = parsePage(c);
  const openRaw = c.req.query("open");
  const addrChain = chainFilter === "all" ? "STARKNET" : chainFilter.chain;
  const ownedPairs = await resolveOwnedPairs(addrChain, c.req.query("owner") ?? undefined);
  const where = buildProposalListWhere({
    chainFilter,
    nftContract: c.req.query("nftContract") ?? undefined,
    proposer: c.req.query("proposer") ?? undefined,
    open: openRaw === undefined ? undefined : openRaw === "true",
    ownedPairs,
  });
  const [rows, total] = await Promise.all([
    prisma.sponsorshipProposal.findMany({ where, orderBy: { createdAtChain: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.sponsorshipProposal.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeProposal), meta: { page, limit, total } });
});

sponsorship.get("/proposals/:proposalId", publicCache(15), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const proposal = await prisma.sponsorshipProposal.findFirst({ where: { chain, proposalId: c.req.param("proposalId") } });
  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  return c.json({ data: serializeProposal(proposal) });
});

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
