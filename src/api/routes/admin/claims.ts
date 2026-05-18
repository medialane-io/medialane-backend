import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth.js";
import prisma from "../../../db/client.js";
import { generateApiKey } from "../../../utils/apiKey.js";
import { handleMetadataFetch } from "../../../orchestrator/metadata.js";
import { handleCollectionMetadataFetch } from "../../../orchestrator/collectionMetadata.js";
import { handleStatsUpdate } from "../../../orchestrator/stats.js";
import { runTransferFollowups } from "../../../orchestrator/transferFollowup.js";
import { worker } from "../../../orchestrator/worker.js";
import { createLogger } from "../../../utils/logger.js";
import { sendUsernameClaimApproved, sendUsernameClaimRejected } from "../../../utils/mailer.js";
import { normalizeAddress, normalizeHash } from "../../../utils/starknet.js";
import { handleOrderCreated } from "../../../mirror/handlers/orderCreated.js";
import { handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated1155.js";
import { pollCollectionCreatedEvents, pollTransferEvents, getLatestBlock } from "../../../mirror/poller.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { MARKETPLACE_1155_CONTRACT, ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress } from "../../../config/constants.js";
import { num } from "starknet";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";

const log = createLogger("routes:admin");

export function registerClaimRoutes(admin: Hono) {
// GET /admin/claims — list collection claims with optional filters
// ---------------------------------------------------------------------------
admin.get("/claims", async (c) => {
  const status = c.req.query("status");
  const verificationMethod = c.req.query("verificationMethod");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (verificationMethod) where.verificationMethod = verificationMethod;

  const [claims, total] = await Promise.all([
    prisma.collectionClaim.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.collectionClaim.count({ where }),
  ]);

  return c.json({ claims, total, page, limit });
});

// ---------------------------------------------------------------------------
// PATCH /admin/claims/:id — approve or reject a manual claim
// ---------------------------------------------------------------------------
admin.patch("/claims/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { status, adminNotes, service } = body;

  if (!["APPROVED", "REJECTED"].includes(status)) {
    return c.json({ error: "status must be APPROVED or REJECTED" }, 400);
  }

  const claim = await prisma.collectionClaim.findUnique({ where: { id } });
  if (!claim) return c.json({ error: "Claim not found" }, 404);

  const updated = await prisma.collectionClaim.update({
    where: { id },
    data: { status, adminNotes, reviewedBy: "admin", reviewedAt: new Date() },
  });

  if (status === "APPROVED") {
    const normContract = normalizeAddress(claim.contractAddress);
    const normWallet = claim.claimantAddress ? normalizeAddress(claim.claimantAddress) : null;

    const existing = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
    });

    if (!existing) {
      await prisma.collection.create({
        data: { chain: "STARKNET", contractAddress: normContract, service: service ?? null, claimedBy: normWallet, metadataStatus: "PENDING", startBlock: BigInt(0) },
      });
      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: normContract });
    } else {
      await prisma.collection.update({
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
        data: { claimedBy: normWallet, ...(service ? { service } : {}) },
      });
    }
  }

  return c.json({ claim: updated });
});

// ---------------------------------------------------------------------------
// GET /admin/username-claims — list username claims with optional status filter
// ---------------------------------------------------------------------------
admin.get("/username-claims", async (c) => {
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const where = status ? { status: status as any } : {};

  const [claims, total] = await Promise.all([
    prisma.usernameClaim.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.usernameClaim.count({ where }),
  ]);

  return c.json({ claims, total, page, limit });
});

// ---------------------------------------------------------------------------
// PATCH /admin/username-claims/:id — approve or reject a username claim
// On approve: sets username on CreatorProfile and rejects any other pending
// claims for the same wallet or the same username.
// ---------------------------------------------------------------------------
admin.patch("/username-claims/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { status, adminNotes } = body;

  if (!["APPROVED", "REJECTED"].includes(status)) {
    return c.json({ error: "status must be APPROVED or REJECTED" }, 400);
  }

  const claim = await prisma.usernameClaim.findUnique({ where: { id } });
  if (!claim) return c.json({ error: "Claim not found" }, 404);
  if (claim.status !== "PENDING") return c.json({ error: "Claim is no longer pending" }, 409);

  const updated = await prisma.usernameClaim.update({
    where: { id },
    data: { status, adminNotes: adminNotes ?? null, reviewedAt: new Date() },
  });

  if (status === "APPROVED") {
    // Write the approved username onto the creator's profile (upsert in case
    // they haven't created a profile record yet)
    await prisma.creatorProfile.upsert({
      where: { walletAddress: claim.walletAddress },
      create: { walletAddress: claim.walletAddress, chain: "STARKNET", username: claim.username },
      update: { username: claim.username },
    });

    // Reject any other pending claims from this wallet or for this username
    await prisma.usernameClaim.updateMany({
      where: {
        id: { not: id },
        status: "PENDING",
        OR: [{ walletAddress: claim.walletAddress }, { username: claim.username }],
      },
      data: { status: "REJECTED", adminNotes: "Superseded by approved claim", reviewedAt: new Date() },
    });

    if (claim.notifyEmail) {
      sendUsernameClaimApproved(claim.notifyEmail, claim.username).catch(() => {});
    }
  } else if (status === "REJECTED" && claim.notifyEmail) {
    sendUsernameClaimRejected(claim.notifyEmail, claim.username, adminNotes ?? null).catch(() => {});
  }

  return c.json({ claim: updated });
});

// ---------------------------------------------------------------------------
// GET /admin/collection-slug-claims — list collection slug claims
// ---------------------------------------------------------------------------
admin.get("/collection-slug-claims", async (c) => {
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const where = status ? { status: status as any } : {};

  const [claims, total] = await Promise.all([
    prisma.collectionSlugClaim.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.collectionSlugClaim.count({ where }),
  ]);

  return c.json({ claims, total, page, limit });
});

// ---------------------------------------------------------------------------
// PATCH /admin/collection-slug-claims/:id — approve or reject a collection slug claim
// On approve: sets slug on CollectionProfile (upsert) and rejects any other
// pending claims for the same slug or same contractAddress.
// ---------------------------------------------------------------------------
admin.patch("/collection-slug-claims/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { status, adminNotes } = body;

  if (!["APPROVED", "REJECTED"].includes(status)) {
    return c.json({ error: "status must be APPROVED or REJECTED" }, 400);
  }

  const claim = await prisma.collectionSlugClaim.findUnique({ where: { id } });
  if (!claim) return c.json({ error: "Claim not found" }, 404);
  if (claim.status !== "PENDING") return c.json({ error: "Claim is no longer pending" }, 409);

  const updated = await prisma.collectionSlugClaim.update({
    where: { id },
    data: { status, adminNotes: adminNotes ?? null, reviewedAt: new Date() },
  });

  if (status === "APPROVED") {
    await prisma.collectionProfile.upsert({
      where: { chain_contractAddress: { chain: claim.chain, contractAddress: claim.contractAddress } },
      create: { chain: claim.chain, contractAddress: claim.contractAddress, slug: claim.slug },
      update: { slug: claim.slug },
    });

    await prisma.collectionSlugClaim.updateMany({
      where: {
        id: { not: id },
        status: "PENDING",
        OR: [{ slug: claim.slug }, { contractAddress: claim.contractAddress }],
      },
      data: { status: "REJECTED", adminNotes: "Superseded by approved claim", reviewedAt: new Date() },
    });
  }

  return c.json({ claim: updated });
});

// ---------------------------------------------------------------------------
}
