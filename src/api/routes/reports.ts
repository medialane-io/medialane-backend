import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";

const HEX64 = /^0x[0-9a-f]{64}$/;

function validateTargetKey(
  targetType: string,
  targetKey: string,
  fields: { targetContract?: string; targetTokenId?: string; targetAddress?: string }
): string | null {
  const parts = targetKey.split(":");

  if (targetType === "COLLECTION") {
    if (parts.length !== 2 || parts[0] !== "COLLECTION" || !HEX64.test(parts[1])) {
      return "targetKey must be 'COLLECTION:0x<64-char hex>' for COLLECTION targets";
    }
    if (fields.targetContract && parts[1] !== fields.targetContract) {
      return "targetKey contract address does not match targetContract field";
    }
  } else if (targetType === "TOKEN") {
    if (parts.length !== 3 || parts[0] !== "TOKEN" || !HEX64.test(parts[1])) {
      return "targetKey must be 'TOKEN:0x<64-char hex>:<tokenId>' for TOKEN targets";
    }
    if (fields.targetContract && parts[1] !== fields.targetContract) {
      return "targetKey contract address does not match targetContract field";
    }
    if (fields.targetTokenId && parts[2] !== fields.targetTokenId) {
      return "targetKey tokenId does not match targetTokenId field";
    }
  } else if (targetType === "CREATOR") {
    if (parts.length !== 2 || parts[0] !== "CREATOR" || !HEX64.test(parts[1])) {
      return "targetKey must be 'CREATOR:0x<64-char hex>' for CREATOR targets";
    }
    if (fields.targetAddress && parts[1] !== fields.targetAddress) {
      return "targetKey address does not match targetAddress field";
    }
  }

  return null;
}

const reports = new Hono<AppEnv>();

const submitReportSchema = z.object({
  targetType: z.enum(["COLLECTION", "TOKEN", "CREATOR"]),
  targetKey: z.string().min(1),
  targetContract: z.string().optional(),
  targetTokenId: z.string().optional(),
  targetAddress: z.string().optional(),
  reporterUserId: z.string().min(1),
  categories: z
    .array(
      z.enum([
        "COPYRIGHT_PIRACY",
        "VIOLENCE_GRAPHIC",
        "HATE_SPEECH",
        "SCAM_FRAUD",
        "SPAM",
        "NSFW",
        "OTHER",
      ])
    )
    .min(1, "At least one category is required"),
  description: z.string().max(500).optional(),
});

// POST /v1/reports
reports.post("/", zValidator("json", submitReportSchema), async (c) => {
  const body = c.req.valid("json");

  // Normalize addresses (defence-in-depth — proxy normalizes before computing targetKey)
  const targetContract = body.targetContract
    ? normalizeAddress(body.targetContract)
    : undefined;
  const targetAddress = body.targetAddress
    ? normalizeAddress(body.targetAddress)
    : undefined;

  const keyError = validateTargetKey(body.targetType, body.targetKey, {
    targetContract,
    targetTokenId: body.targetTokenId,
    targetAddress,
  });
  if (keyError) {
    return c.json({ error: keyError }, 400);
  }

  // Per-user rate limit: max 5 reports per hour (DB-backed)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await prisma.report.count({
    where: {
      reporterUserId: body.reporterUserId,
      createdAt: { gte: oneHourAgo },
    },
  });
  if (recentCount >= 5) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  // Deduplication: one report per user per target (@@unique enforced at DB level too)
  const existing = await prisma.report.findUnique({
    where: {
      targetKey_reporterUserId: {
        targetKey: body.targetKey,
        reporterUserId: body.reporterUserId,
      },
    },
  });
  if (existing) {
    return c.json({ error: "Already reported" }, 409);
  }

  const report = await prisma.report.create({
    data: {
      targetType: body.targetType,
      targetKey: body.targetKey,
      targetContract,
      targetTokenId: body.targetTokenId,
      targetAddress,
      reporterUserId: body.reporterUserId,
      categories: body.categories,
      description: body.description,
    },
  });

  return c.json({ data: report }, 201);
});

export default reports;
