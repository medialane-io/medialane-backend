import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:rewards");

const rewards = new Hono();

rewards.get("/config", async (c) => {
  const [levels, actions, badges] = await Promise.all([
    prisma.rewardLevel.findMany({
      orderBy: { level: "asc" },
      select: { level: true, name: true, xpRequired: true, badgeColor: true, description: true },
    }),
    prisma.rewardAction.findMany({
      where: { enabled: true },
      orderBy: { type: "asc" },
      select: { type: true, label: true, xp: true, dailyCap: true },
    }),
    prisma.badgeDefinition.findMany({
      where: { enabled: true },
      orderBy: [{ category: "asc" }, { key: "asc" }],
      select: { key: true, name: true, description: true, icon: true, color: true, category: true },
    }),
  ]);
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ data: { levels, actions, badges } });
});

rewards.get("/batch", async (c) => {
  const raw = (c.req.query("addresses") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (raw.length === 0 || raw.length > 50) return c.json({ error: "Provide 1–50 addresses" }, 400);
  const addresses = raw.map((a) => normalizeAddress("STARKNET", a));
  const [scores, levels] = await Promise.all([
    prisma.userScore.findMany({ where: { address: { in: addresses } } }),
    prisma.rewardLevel.findMany({ orderBy: { level: "asc" } }),
  ]);
  const levelMap = new Map(levels.map((l) => [l.level, l]));
  const byAddress = new Map(scores.map((s) => [s.address, s]));
  const starter = levels[0] ?? { level: 1, name: "Starter", badgeColor: "#64748b" };
  return c.json({
    data: addresses.map((address) => {
      const s = byAddress.get(address);
      const lvl = s ? levelMap.get(s.currentLevel) ?? starter : starter;
      return {
        address,
        totalXp: s?.totalXp ?? 0,
        currentLevel: s?.currentLevel ?? 1,
        currentLevelName: lvl.name,
        badgeColor: lvl.badgeColor,
      };
    }),
  });
});

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

export { rewards };
