import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../../middleware/adminSecretAuth.js";
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
import { handleOrderCreated, handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated.js";
import { pollCollectionCreatedEvents, pollTransferEvents, getLatestBlock } from "../../../mirror/poller.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress } from "../../../config/constants.js";
import { num } from "starknet";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";

const log = createLogger("routes:admin");

export function registerModerationRoutes(admin: Hono) {
// GET /admin/reports — list reports, paginated, enriched with target name + image
// ---------------------------------------------------------------------------
admin.get("/reports", async (c) => {
  const { status, targetType, page = "1", limit = "20" } = c.req.query();

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * limitNum;

  const where: Record<string, unknown> = {};
  if (status) {
    const statuses = status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    where.status = statuses.length === 1 ? statuses[0] : ({ in: statuses } as any);
  }
  if (targetType) where.targetType = targetType;

  const [rawReports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
    prisma.report.count({ where }),
  ]);

  // Batch enrich: one query per type to avoid N+1
  const collectionContracts = [
    ...new Set(
      rawReports
        .filter((r) => r.targetType === "COLLECTION" && r.targetContract)
        .map((r) => r.targetContract!)
    ),
  ];
  const tokenKeys = rawReports
    .filter((r) => r.targetType === "TOKEN" && r.targetContract && r.targetTokenId)
    .map((r) => ({ contractAddress: r.targetContract!, tokenId: r.targetTokenId! }));

  const [collectionMeta, tokenMeta] = await Promise.all([
    collectionContracts.length > 0
      ? prisma.collection.findMany({
          where: { contractAddress: { in: collectionContracts } },
          select: { contractAddress: true, name: true, image: true },
        })
      : Promise.resolve([]),
    tokenKeys.length > 0
      ? prisma.token.findMany({
          where: {
            OR: tokenKeys.map((k) => ({
              contractAddress: k.contractAddress,
              tokenId: k.tokenId,
            })),
          },
          select: { contractAddress: true, tokenId: true, name: true, image: true },
        })
      : Promise.resolve([]),
  ]);

  const colByContract = new Map(collectionMeta.map((c) => [c.contractAddress, c]));
  const tokenByKey = new Map(
    tokenMeta.map((t) => [`${t.contractAddress}:${t.tokenId}`, t])
  );

  const enriched = rawReports.map((r) => {
    let targetName: string | null = null;
    let targetImage: string | null = null;

    if (r.targetType === "COLLECTION" && r.targetContract) {
      const col = colByContract.get(r.targetContract);
      targetName = col?.name ?? null;
      targetImage = col?.image ?? null;
    } else if (r.targetType === "TOKEN" && r.targetContract && r.targetTokenId) {
      const tok = tokenByKey.get(`${r.targetContract}:${r.targetTokenId}`);
      targetName = tok?.name ?? null;
      targetImage = tok?.image ?? null;
    }

    return { ...r, targetName, targetImage };
  });

  return c.json({ reports: enriched, total, page: pageNum, pageSize: limitNum });
});

// ---------------------------------------------------------------------------
// PATCH /admin/reports/:id — review action with atomic visibility side effects
// ---------------------------------------------------------------------------
admin.patch("/reports/:id", async (c) => {
  const { id } = c.req.param();

  let body: { status?: string; adminNotes?: string; reviewedBy?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const validStatuses = [
    "PENDING",
    "UNDER_REVIEW",
    "HIDDEN",
    "DISMISSED",
    "RESTORED",
  ] as const;

  if (!body.status || !validStatuses.includes(body.status as (typeof validStatuses)[number])) {
    return c.json({ error: "status is required and must be a valid ReportStatus" }, 400);
  }
  const newStatus = body.status as (typeof validStatuses)[number];

  if (
    (newStatus === "HIDDEN" || newStatus === "DISMISSED") &&
    !body.adminNotes?.trim()
  ) {
    return c.json(
      { error: "adminNotes are required for HIDDEN and DISMISSED actions" },
      400
    );
  }

  const report = await prisma.report.findUnique({ where: { id } });
  if (!report) return c.json({ error: "Report not found" }, 404);

  // Atomic: update report status + apply visibility side effect in one transaction
  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id },
      data: {
        status: newStatus,
        adminNotes: body.adminNotes?.trim() || undefined,
        reviewedBy: body.reviewedBy || undefined,
        reviewedAt: new Date(),
      },
    });

    if (newStatus === "HIDDEN") {
      if (report.targetType === "COLLECTION" && report.targetContract) {
        await tx.collection.updateMany({
          where: { contractAddress: report.targetContract, chain: report.chain },
          data: { isHidden: true },
        });
      } else if (
        report.targetType === "TOKEN" &&
        report.targetContract &&
        report.targetTokenId
      ) {
        await tx.token.updateMany({
          where: {
            contractAddress: report.targetContract,
            tokenId: report.targetTokenId,
            chain: report.chain,
          },
          data: { isHidden: true },
        });
      } else if (report.targetType === "CREATOR" && report.targetAddress) {
        // Upsert is idempotent — safe if creator already hidden by another report
        await tx.hiddenCreator.upsert({
          where: {
            chain_address: { chain: report.chain, address: report.targetAddress },
          },
          create: { chain: report.chain, address: report.targetAddress },
          update: {},
        });
      }
    } else if (newStatus === "RESTORED") {
      // Only clear visibility if NO other HIDDEN reports exist for this target
      const otherHidden = await tx.report.count({
        where: {
          targetKey: report.targetKey,
          status: "HIDDEN",
          id: { not: id },
        },
      });

      if (otherHidden === 0) {
        if (report.targetType === "COLLECTION" && report.targetContract) {
          await tx.collection.updateMany({
            where: { contractAddress: report.targetContract, chain: report.chain },
            data: { isHidden: false },
          });
        } else if (
          report.targetType === "TOKEN" &&
          report.targetContract &&
          report.targetTokenId
        ) {
          await tx.token.updateMany({
            where: {
              contractAddress: report.targetContract,
              tokenId: report.targetTokenId,
              chain: report.chain,
            },
            data: { isHidden: false },
          });
        } else if (report.targetType === "CREATOR" && report.targetAddress) {
          await tx.hiddenCreator.deleteMany({
            where: { chain: report.chain, address: report.targetAddress },
          });
        }
      }
    }
  });

  const updated = await prisma.report.findUnique({ where: { id } });
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// PATCH /admin/creators/:oldAddress/fix-wallet — correct a wrong wallet address
// Updates the address on the Wallet and on any UsernameClaim records.
// ---------------------------------------------------------------------------
admin.patch("/creators/:oldAddress/fix-wallet", async (c) => {
  const oldRaw = c.req.param("oldAddress");
  const body = await c.req.json();
  const newRaw = body.newAddress as string | undefined;
  if (!newRaw) return c.json({ error: "newAddress required" }, 400);

  const oldAddr = normalizeAddress(oldRaw);
  const newAddr = normalizeAddress(newRaw);

  const [walletUpdate, claimUpdate] = await Promise.all([
    prisma.wallet.updateMany({
      where: { address: oldAddr },
      data: { address: newAddr },
    }),
    prisma.usernameClaim.updateMany({
      where: { walletAddress: oldAddr },
      data: { walletAddress: newAddr },
    }),
  ]);

  log.info({ oldAddr, newAddr, walletUpdate, claimUpdate }, "Creator wallet address corrected");
  return c.json({ data: { oldAddr, newAddr, walletUpdate, claimUpdate } });
});

// ---------------------------------------------------------------------------
// GET /admin/comments — list comments (newest first, optional filters)
// Query params: ?hidden=true|false, ?author=0x..., ?contract=0x..., ?page=1, ?limit=50
// ---------------------------------------------------------------------------
admin.get("/comments", async (c) => {
  const hidden = c.req.query("hidden");
  const author = c.req.query("author");
  const contract = c.req.query("contract");
  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "50")));

  const where: Record<string, unknown> = {};
  if (hidden === "true") where.isHidden = true;
  if (hidden === "false") where.isHidden = false;
  if (author) where.author = normalizeAddress(author);
  if (contract) where.contractAddress = normalizeAddress(contract);

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.comment.count({ where }),
  ]);

  return c.json({ data: comments, meta: { page, limit, total } });
});

// ---------------------------------------------------------------------------
// PATCH /admin/comments/:id/hide
// ---------------------------------------------------------------------------
admin.patch("/comments/:id/hide", async (c) => {
  const { id } = c.req.param();
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  const updated = await prisma.comment.update({
    where: { id },
    data: { isHidden: true },
  });
  log.info({ id }, "Comment hidden by admin");
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// PATCH /admin/comments/:id/show
// ---------------------------------------------------------------------------
admin.patch("/comments/:id/show", async (c) => {
  const { id } = c.req.param();
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  const updated = await prisma.comment.update({
    where: { id },
    data: { isHidden: false },
  });
  log.info({ id }, "Comment restored by admin");
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// PATCH /admin/remix-offers/:id — override creatorAddress when token transfer caused stale state
// ---------------------------------------------------------------------------
admin.patch("/remix-offers/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  if (!body.creatorAddress) {
    return c.json({ error: "creatorAddress is required" }, 400);
  }

  const updated = await prisma.remixOffer.update({
    where: { id },
    data: { creatorAddress: normalizeAddress(body.creatorAddress) },
  });

  return c.json({ data: { id: updated.id, creatorAddress: updated.creatorAddress } });
});

// ---------------------------------------------------------------------------
}
