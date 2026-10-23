import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { buildOfferListWhere, buildProposalListWhere, buildLicenseListWhere } from "./sponsorship.filters.js";
import type { Prisma, PrismaClient, SponsorshipOffer, SponsorshipBid, SponsorshipProposal, SponsorshipLicense, Chain } from "@prisma/client";
import { chainFilterScope, chainScope } from "../http/chain.js";
import { pageQuery } from "../http/page.js";

const sponsorship = new Hono<AppEnv>();

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_OWNED_TOKEN_LOOKUP = 500;

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

export async function resolveOwnedPairs(chain: Chain, ownerRaw: string | undefined, db: Db = prisma) {
  if (!ownerRaw) return undefined;
  const owner = normalizeAddress(chain, ownerRaw);
  const held = await db.tokenBalance.findMany({
    where: { chain, owner, amount: { not: "0" } },
    orderBy: { updatedAt: "desc" },
    take: MAX_OWNED_TOKEN_LOOKUP,
    select: { contractAddress: true, tokenId: true },
  });
  return held.map((t) => ({ contractAddress: t.contractAddress, tokenId: t.tokenId }));
}

export async function resolveHolderTokenIds(chain: Chain, holderRaw: string, db: Db = prisma) {
  const holder = normalizeAddress(chain, holderRaw);
  const held = await db.tokenBalance.findMany({
    where: { chain, owner: holder, amount: { not: "0" } },
    orderBy: { updatedAt: "desc" },
    take: MAX_OWNED_TOKEN_LOOKUP,
    select: { tokenId: true },
  });
  return held.map((t) => t.tokenId);
}

sponsorship.get("/offers", chainFilterScope(), zValidator("query", pageQuery({ defaultLimit: 24 })), async (c) => {
  const chainFilter = c.get("chainFilter");
  const { page, limit } = c.req.valid("query");
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

sponsorship.get("/offers/:offerId", chainScope(), async (c) => {
  const chain = c.get("chain");
  const offer = await prisma.sponsorshipOffer.findFirst({ where: { chain, offerId: c.req.param("offerId") } });
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  return c.json({ data: serializeOffer(offer) });
});

sponsorship.get("/offers/:offerId/bids", chainScope(), async (c) => {
  const chain = c.get("chain");
  const bids = await prisma.sponsorshipBid.findMany({
    where: { chain, offerId: c.req.param("offerId") },
    orderBy: { placedAtChain: "desc" },
  });
  return c.json({ data: bids.map(serializeBid) });
});

sponsorship.get("/proposals", chainFilterScope(), zValidator("query", pageQuery({ defaultLimit: 24 })), async (c) => {
  const chainFilter = c.get("chainFilter");
  const { page, limit } = c.req.valid("query");
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

sponsorship.get("/proposals/:proposalId", chainScope(), async (c) => {
  const chain = c.get("chain");
  const proposal = await prisma.sponsorshipProposal.findFirst({ where: { chain, proposalId: c.req.param("proposalId") } });
  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  return c.json({ data: serializeProposal(proposal) });
});

sponsorship.get("/licenses", chainFilterScope(), zValidator("query", pageQuery({ defaultLimit: 24 })), async (c) => {
  const chainFilter = c.get("chainFilter");
  const { page, limit } = c.req.valid("query");
  const holderRaw = c.req.query("holder");

  let tokenIdFilter: { in: string[] } | undefined;
  if (holderRaw) {
    const chain = chainFilter === "all" ? "STARKNET" : chainFilter.chain;
    tokenIdFilter = { in: await resolveHolderTokenIds(chain, holderRaw) };
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

sponsorship.get("/licenses/:tokenId", chainScope(), async (c) => {
  const chain = c.get("chain");
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
