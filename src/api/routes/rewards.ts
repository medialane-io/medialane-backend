import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/adminSecretAuth.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { runComputeGuarded } from "../../orchestrator/rewardsCompute.js";

const log = createLogger("routes:rewards");

const rewards = new Hono();

// ── Public tenant routes ──────────────────────────────────────────────────────

// GET /v1/rewards/:address — score + level + badges for one address
rewards.get("/:address", async (c) => {
  const address = normalizeAddress("STARKNET", c.req.param("address"));

  const [score, badges, levels, walletIdentity] = await Promise.all([
    prisma.userScore.findUnique({ where: { address } }),
    prisma.userBadge.findMany({
      where: { address },
      include: { badge: { select: { key: true, name: true, description: true, icon: true, color: true, category: true } } },
      orderBy: { awardedAt: "asc" },
    }),
    prisma.rewardLevel.findMany({ orderBy: { level: "asc" } }),
    prisma.identity.findUnique({
      where: { chain_address: { chain: "STARKNET", address } },
      include: { account: { select: { publicId: true } } },
    }),
  ]);
  const accountId = walletIdentity?.accountId ?? null;
  const publicId = walletIdentity?.account?.publicId ?? null;

  if (!score) {
    // Return zeroed state for addresses not yet in the system
    const starterLevel = levels[0] ?? { level: 1, name: "Starter", xpRequired: 0, badgeColor: "#64748b" };
    return c.json({
      data: {
        address,
        accountId,
        publicId,
        totalXp: 0,
        currentLevel: 1,
        currentLevelName: starterLevel.name,
        badgeColor: starterLevel.badgeColor,
        nextLevel: levels[1] ?? null,
        progressPct: 0,
        breakdown: {},
        badges: [],
        computedAt: null,
      },
    });
  }

  const currentLevelData = levels.find((l) => l.level === score.currentLevel) ?? levels[0];
  const nextLevelData = levels.find((l) => l.level === score.currentLevel + 1) ?? null;

  let progressPct = 100;
  if (nextLevelData) {
    const xpIntoLevel = score.totalXp - (currentLevelData?.xpRequired ?? 0);
    const xpNeeded = nextLevelData.xpRequired - (currentLevelData?.xpRequired ?? 0);
    progressPct = Math.min(100, Math.round((xpIntoLevel / xpNeeded) * 100));
  }

  return c.json({
    data: {
      address,
      accountId,
      publicId,
      totalXp: score.totalXp,
      currentLevel: score.currentLevel,
      currentLevelName: currentLevelData?.name ?? "Starter",
      badgeColor: currentLevelData?.badgeColor ?? "#64748b",
      nextLevel: nextLevelData
        ? { level: nextLevelData.level, name: nextLevelData.name, xpRequired: nextLevelData.xpRequired }
        : null,
      progressPct,
      breakdown: score.breakdown,
      badges: badges.map((b) => b.badge),
      computedAt: score.computedAt,
    },
  });
});

// GET /v1/rewards — leaderboard
rewards.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
  const skip = (page - 1) * limit;

  const [total, scores] = await Promise.all([
    prisma.userScore.count(),
    prisma.userScore.findMany({
      orderBy: { totalXp: "desc" },
      skip,
      take: limit,
    }),
  ]);

  const levels = await prisma.rewardLevel.findMany({ orderBy: { level: "asc" } });
  const levelMap = new Map(levels.map((l) => [l.level, l]));

  // Batch-fetch publicIds for scores that have an accountId — one query, no N+1.
  const accountIds = scores.map((s) => s.accountId).filter((id): id is string => id != null);
  const accounts = accountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, publicId: true },
      })
    : [];
  const publicIdByAccount = new Map(accounts.map((a) => [a.id, a.publicId]));

  return c.json({
    data: scores.map((s, i) => ({
      rank: skip + i + 1,
      address: s.address,
      accountId: s.accountId,
      publicId: s.accountId ? publicIdByAccount.get(s.accountId) ?? null : null,
      totalXp: s.totalXp,
      currentLevel: s.currentLevel,
      currentLevelName: levelMap.get(s.currentLevel)?.name ?? "Starter",
      badgeColor: levelMap.get(s.currentLevel)?.badgeColor ?? "#64748b",
    })),
    meta: { page, limit, total },
  });
});

// GET /v1/rewards/:address/events — point history for an address
rewards.get("/:address/events", async (c) => {
  const address = normalizeAddress("STARKNET", c.req.param("address"));
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
  const skip = (page - 1) * limit;

  const [total, events] = await Promise.all([
    prisma.pointEvent.count({ where: { address } }),
    prisma.pointEvent.findMany({
      where: { address },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  return c.json({
    data: events.map((e) => ({
      id: e.id,
      actionType: e.actionType,
      xp: e.xp,
      multiplier: e.multiplier,
      finalXp: e.finalXp,
      txHash: e.txHash,
      createdAt: e.createdAt,
    })),
    meta: { page, limit, total },
  });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

const adminRewards = new Hono();
adminRewards.use("*", authMiddleware);

// GET /admin/rewards/config — read current DAO config
adminRewards.get("/config", async (c) => {
  const [actions, multipliers, levels] = await Promise.all([
    prisma.rewardAction.findMany({ orderBy: { type: "asc" } }),
    prisma.rewardMultiplier.findMany({ orderBy: { name: "asc" } }),
    prisma.rewardLevel.findMany({ orderBy: { level: "asc" } }),
  ]);
  return c.json({ data: { actions, multipliers, levels } });
});

// PATCH /admin/rewards/levels/:level — update a level's XP threshold or name
const patchLevelSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  xpRequired: z.number().int().nonnegative().optional(),
  badgeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  description: z.string().nullable().optional(),
});

adminRewards.patch("/levels/:level", async (c) => {
  const level = parseInt(c.req.param("level"), 10);
  if (isNaN(level) || level < 1 || level > 50) return c.json({ error: "Invalid level" }, 400);

  const body = await c.req.json().catch(() => null);
  const parsed = patchLevelSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const updated = await prisma.rewardLevel.update({ where: { level }, data: parsed.data });
  return c.json({ data: updated });
});

// PATCH /admin/rewards/actions/:type — update action weight
const patchActionSchema = z.object({
  xp: z.number().int().nonnegative().optional(),
  dailyCap: z.number().int().nonnegative().nullable().optional(),
  minValueUsdc: z.number().nonnegative().nullable().optional(),
  enabled: z.boolean().optional(),
  label: z.string().min(1).optional(),
});

adminRewards.patch("/actions/:type", async (c) => {
  const type = c.req.param("type");
  const body = await c.req.json().catch(() => null);
  const parsed = patchActionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const existing = await prisma.rewardAction.findUnique({ where: { type } });
  if (!existing) return c.json({ error: "Action not found" }, 404);

  const updated = await prisma.rewardAction.update({ where: { type }, data: parsed.data });
  return c.json({ data: updated });
});

// PATCH /admin/rewards/multipliers/:id — toggle or adjust a multiplier
const patchMultiplierSchema = z.object({
  factor: z.number().positive().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});

adminRewards.patch("/multipliers/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = patchMultiplierSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const existing = await prisma.rewardMultiplier.findUnique({ where: { id } });
  if (!existing) return c.json({ error: "Multiplier not found" }, 404);

  const updated = await prisma.rewardMultiplier.update({ where: { id }, data: parsed.data });
  return c.json({ data: updated });
});

// GET /admin/rewards/badges — list all badge definitions
adminRewards.get("/badges", async (c) => {
  const badges = await prisma.badgeDefinition.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] });
  return c.json({ data: badges });
});

// PATCH /admin/rewards/badges/:key — update a badge definition
const patchBadgeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  enabled: z.boolean().optional(),
});

adminRewards.patch("/badges/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json().catch(() => null);
  const parsed = patchBadgeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const existing = await prisma.badgeDefinition.findUnique({ where: { key } });
  if (!existing) return c.json({ error: "Badge not found" }, 404);

  const updated = await prisma.badgeDefinition.update({ where: { key }, data: parsed.data });
  return c.json({ data: updated });
});

// POST /admin/rewards/badges/:address — manually award a badge
adminRewards.post("/badges/:address", async (c) => {
  const address = normalizeAddress("STARKNET", c.req.param("address"));
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ badgeKey: z.string(), txHash: z.string().optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

  const badge = await prisma.badgeDefinition.findUnique({ where: { key: parsed.data.badgeKey } });
  if (!badge) return c.json({ error: "Badge not found" }, 404);

  const award = await prisma.userBadge.upsert({
    where: { address_badgeKey: { address, badgeKey: parsed.data.badgeKey } },
    update: { txHash: parsed.data.txHash },
    create: { address, badgeKey: parsed.data.badgeKey, txHash: parsed.data.txHash },
  });
  return c.json({ data: award }, 201);
});

// POST /admin/rewards/compute — trigger retroactive XP + badge computation
// in-process (shares a single-flight guard with the scheduled loop).
// Accepts optional ?dry_run=true to preview without writing.
adminRewards.post("/compute", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  log.info({ dryRun }, "Reward computation via admin endpoint");
  const startedAt = Date.now();
  try {
    const result = await runComputeGuarded(dryRun);
    if ("skipped" in result) return c.json({ error: "A computation is already running" }, 409);
    return c.json({ ok: true, dryRun, elapsedMs: Date.now() - startedAt, summary: result });
  } catch (err) {
    log.error({ err }, "Reward computation failed");
    return c.json({ error: "Computation failed" }, 500);
  }
});

export { rewards, adminRewards };
