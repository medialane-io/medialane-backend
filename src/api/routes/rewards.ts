import { Hono } from "hono";
import { validated } from "../http/validate.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { ACTIONS, BADGES, LEVELS } from "../../rewards/config.js";
import { pageQuery } from "@medialane/sdk/contract";

const log = createLogger("routes:rewards");

const rewards = new Hono();

const levels = [...LEVELS]
  .sort((a, b) => a.level - b.level)
  .map((l) => ({ level: l.level, name: l.name, xpRequired: l.xpRequired, badgeColor: l.badgeColor, description: l.description ?? null }));

const badgeView = (b: (typeof BADGES)[number]) => ({
  key: b.key,
  name: b.name,
  description: b.description,
  icon: b.icon,
  color: b.color,
  category: b.category,
});
const badgeByKey = new Map(BADGES.map((b) => [b.key, badgeView(b)]));

rewards.get("/config", (c) => {
  const actions = ACTIONS.filter((a) => a.enabled)
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((a) => ({ type: a.type, label: a.label, xp: a.xp, dailyCap: a.dailyCap }));
  const badges = BADGES.filter((b) => b.enabled)
    .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key))
    .map(badgeView);
  return c.json({ data: { levels, actions, badges } });
});

rewards.get("/batch", async (c) => {
  const raw = (c.req.query("addresses") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (raw.length === 0 || raw.length > 50) return c.json({ error: "Provide 1–50 addresses" }, 400);
  const addresses = raw.map((a) => normalizeAddress("STARKNET", a));
  const scores = await prisma.userScore.findMany({ where: { address: { in: addresses } } });
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

  const [score, badges] = await Promise.all([
    prisma.userScore.findUnique({ where: { address } }),
    prisma.userBadge.findMany({ where: { address }, orderBy: { awardedAt: "asc" }, select: { badgeKey: true } }),
  ]);

  if (!score) {

    const starterLevel = levels[0] ?? { level: 1, name: "Starter", xpRequired: 0, badgeColor: "#64748b" };
    return c.json({
      data: {
        address,
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
      totalXp: score.totalXp,
      currentLevel: score.currentLevel,
      currentLevelName: currentLevelData?.name ?? "Starter",
      badgeColor: currentLevelData?.badgeColor ?? "#64748b",
      nextLevel: nextLevelData
        ? { level: nextLevelData.level, name: nextLevelData.name, xpRequired: nextLevelData.xpRequired }
        : null,
      progressPct,
      breakdown: score.breakdown,
      badges: badges.flatMap((b) => badgeByKey.get(b.badgeKey) ?? []),
      computedAt: score.computedAt,
    },
  });
});

rewards.get("/", validated("query", pageQuery({ defaultLimit: 50 })), async (c) => {
  const { page, limit, skip } = c.req.valid("query");

  const [total, scores] = await Promise.all([
    prisma.userScore.count(),
    prisma.userScore.findMany({
      orderBy: { totalXp: "desc" },
      skip,
      take: limit,
    }),
  ]);

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

rewards.get("/:address/events", validated("query", pageQuery()), async (c) => {
  const address = normalizeAddress("STARKNET", c.req.param("address"));
  const { page, limit, skip } = c.req.valid("query");

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
