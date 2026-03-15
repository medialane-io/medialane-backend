import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";

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
