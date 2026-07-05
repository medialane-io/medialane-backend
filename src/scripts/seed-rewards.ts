/**
 * Seed default reward configuration: 50 levels, action weights,
 * multipliers, and badge definitions. Safe to re-run — uses upsert.
 *
 * Usage: bun run src/scripts/seed-rewards.ts
 */

import prisma from "../db/client.js";

// ── 50 Levels ─────────────────────────────────────────────────────────────────

const LEVELS = [
  // Arc 1: Beginners (1–5)
  { level: 1,  name: "Starter",     xpRequired: 0,       badgeColor: "#64748b", description: "Welcome to Medialane." },
  { level: 2,  name: "Explorer",    xpRequired: 100,     badgeColor: "#64748b" },
  { level: 3,  name: "Apprentice",  xpRequired: 250,     badgeColor: "#64748b" },
  { level: 4,  name: "Cadet",       xpRequired: 500,     badgeColor: "#64748b" },
  { level: 5,  name: "Artisan",     xpRequired: 900,     badgeColor: "#0ea5e9" },

  // Arc 2: Adventurers (6–11)
  { level: 6,  name: "Voyager",     xpRequired: 1_400,   badgeColor: "#0ea5e9" },
  { level: 7,  name: "Fighter",     xpRequired: 2_100,   badgeColor: "#0ea5e9" },
  { level: 8,  name: "Navigator",   xpRequired: 3_000,   badgeColor: "#0ea5e9" },
  { level: 9,  name: "Ranger",      xpRequired: 4_200,   badgeColor: "#0ea5e9" },
  { level: 10, name: "Pirate",      xpRequired: 5_800,   badgeColor: "#0ea5e9" },
  { level: 11, name: "Warrior",     xpRequired: 7_800,   badgeColor: "#0ea5e9" },

  // Arc 3: Masters (12–19)
  { level: 12, name: "Technician",  xpRequired: 10_500,  badgeColor: "#8b5cf6" },
  { level: 13, name: "Luminary",    xpRequired: 14_000,  badgeColor: "#8b5cf6" },
  { level: 14, name: "Knight",      xpRequired: 18_500,  badgeColor: "#8b5cf6" },
  { level: 15, name: "Samurai",     xpRequired: 24_000,  badgeColor: "#8b5cf6" },
  { level: 16, name: "Ninja",       xpRequired: 31_000,  badgeColor: "#8b5cf6" },
  { level: 17, name: "Virtuoso",    xpRequired: 40_000,  badgeColor: "#8b5cf6" },
  { level: 18, name: "Wizard",      xpRequired: 51_000,  badgeColor: "#8b5cf6" },
  { level: 19, name: "Paladin",     xpRequired: 65_000,  badgeColor: "#8b5cf6" },

  // Arc 4: Icons (20–30)
  { level: 20, name: "Collector",   xpRequired: 82_000,  badgeColor: "#f59e0b" },
  { level: 21, name: "Hero",        xpRequired: 103_000, badgeColor: "#f59e0b" },
  { level: 22, name: "Master",      xpRequired: 130_000, badgeColor: "#f59e0b" },
  { level: 23, name: "Alchemist",   xpRequired: 163_000, badgeColor: "#f59e0b" },
  { level: 24, name: "Sage",        xpRequired: 203_000, badgeColor: "#f59e0b" },
  { level: 25, name: "Curator",     xpRequired: 253_000, badgeColor: "#f59e0b" },
  { level: 26, name: "Oracle",      xpRequired: 315_000, badgeColor: "#f59e0b" },
  { level: 27, name: "Superhero",   xpRequired: 390_000, badgeColor: "#f59e0b" },
  { level: 28, name: "Idol",        xpRequired: 480_000, badgeColor: "#f59e0b" },
  { level: 29, name: "Patron",      xpRequired: 590_000, badgeColor: "#f59e0b" },
  { level: 30, name: "Icon",        xpRequired: 720_000, badgeColor: "#f59e0b" },

  // Arc 5: Legends (31–35)
  { level: 31, name: "Ethereal",    xpRequired: 880_000,   badgeColor: "#ec4899" },
  { level: 32, name: "Legend",      xpRequired: 1_070_000, badgeColor: "#ec4899" },
  { level: 33, name: "Masterpiece", xpRequired: 1_300_000, badgeColor: "#ec4899" },
  { level: 34, name: "Mythic",      xpRequired: 1_580_000, badgeColor: "#ec4899" },
  { level: 35, name: "Elite",       xpRequired: 1_920_000, badgeColor: "#ec4899" },

  // Arc 6: Cosmic (36–42)
  { level: 36, name: "Sovereign",   xpRequired: 2_330_000, badgeColor: "#6366f1" },
  { level: 37, name: "Phantom",     xpRequired: 2_820_000, badgeColor: "#6366f1" },
  { level: 38, name: "Titan",       xpRequired: 3_400_000, badgeColor: "#6366f1" },
  { level: 39, name: "Visionary",   xpRequired: 4_080_000, badgeColor: "#6366f1" },
  { level: 40, name: "Celestial",   xpRequired: 4_880_000, badgeColor: "#6366f1" },
  { level: 41, name: "Immortal",    xpRequired: 5_820_000, badgeColor: "#6366f1" },
  { level: 42, name: "Renaissance", xpRequired: 6_920_000, badgeColor: "#6366f1" },

  // Arc 7: Transcendent (43–50)
  { level: 43, name: "Phenomenon",  xpRequired: 8_200_000,  badgeColor: "#10b981" },
  { level: 44, name: "Architect",   xpRequired: 9_700_000,  badgeColor: "#10b981" },
  { level: 45, name: "Cosmic",      xpRequired: 11_500_000, badgeColor: "#10b981" },
  { level: 46, name: "Infinite",    xpRequired: 13_600_000, badgeColor: "#10b981" },
  { level: 47, name: "Singularity", xpRequired: 16_100_000, badgeColor: "#10b981" },
  { level: 48, name: "Transcendent",xpRequired: 19_000_000, badgeColor: "#10b981" },
  { level: 49, name: "Origin",      xpRequired: 22_500_000, badgeColor: "#10b981" },
  { level: 50, name: "Genesis",     xpRequired: 26_500_000, badgeColor: "#10b981", description: "The ultimate rank. You create worlds." },
];

// ── Action weights ─────────────────────────────────────────────────────────────

const ACTIONS = [
  { type: "complete_profile",       label: "Complete profile",           xp: 50,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "mint_asset",             label: "Mint an IP asset",           xp: 20,  dailyCap: 10,   minValueUsdc: null, enabled: true },
  { type: "create_collection",      label: "Create a collection",        xp: 50,  dailyCap: 5,    minValueUsdc: null, enabled: true },
  { type: "launch_launchpad",       label: "Launch Drop / POP / Edition",xp: 100, dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "create_remix",           label: "Create a remix",             xp: 25,  dailyCap: 5,    minValueUsdc: null, enabled: true },
  { type: "list_asset",             label: "List an asset",              xp: 5,   dailyCap: 20,   minValueUsdc: 0.5,  enabled: true },
  { type: "buy_asset",              label: "Buy an asset",               xp: 15,  dailyCap: 10,   minValueUsdc: 0.5,  enabled: true },
  { type: "make_offer",             label: "Make an offer",              xp: 8,   dailyCap: 15,   minValueUsdc: 0.5,  enabled: true },
  { type: "counter_offer",          label: "Counter an offer",           xp: 8,   dailyCap: 10,   minValueUsdc: null, enabled: true },
  { type: "offer_accepted_seller",  label: "Offer accepted (seller)",    xp: 20,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "offer_accepted_buyer",   label: "Offer accepted (buyer)",     xp: 20,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "claim_pop",              label: "Claim a POP",                xp: 10,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "claim_drop",             label: "Claim a Drop mint",          xp: 10,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "comment",                label: "On-chain comment",           xp: 4,   dailyCap: 5,    minValueUsdc: null, enabled: true },
  // Disabled until referral tracking exists — never fake a data source.
  { type: "refer_user",             label: "Refer an active user",       xp: 30,  dailyCap: null, minValueUsdc: null, enabled: false },
  // Launchpad services (2026-07-04)
  { type: "create_ticket_collection",     label: "Create a ticketed event",        xp: 100, dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "buy_ticket",                   label: "Get an event ticket",            xp: 15,  dailyCap: 10,   minValueUsdc: null, enabled: true },
  { type: "create_club",                  label: "Start a club",                   xp: 100, dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "join_club",                    label: "Join a club",                    xp: 15,  dailyCap: 10,   minValueUsdc: null, enabled: true },
  { type: "create_sponsorship_offer",     label: "Open a sponsorship",             xp: 50,  dailyCap: 5,    minValueUsdc: null, enabled: true },
  { type: "place_sponsorship_bid",        label: "Bid on a sponsorship",           xp: 15,  dailyCap: 10,   minValueUsdc: null, enabled: true },
  { type: "sponsorship_licensed_sponsor", label: "Sponsorship secured (sponsor)",  xp: 40,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "sponsorship_licensed_author",  label: "Sponsorship secured (creator)",  xp: 40,  dailyCap: null, minValueUsdc: null, enabled: true },
  { type: "launch_coin",                  label: "Launch a creator coin",          xp: 150, dailyCap: null, minValueUsdc: null, enabled: true },
];

// ── Multipliers ────────────────────────────────────────────────────────────────

const MULTIPLIERS = [
  { name: "Beta Tester",   description: "Any action before public launch", factor: 1.5, condition: "beta_tester",   enabled: true },
  { name: "First 100",     description: "One of the first 100 users",      factor: 2.0, condition: "first_100",     enabled: true },
  { name: "Loyalty",       description: "All listings exclusively on Medialane (scales 1.0–1.5×)", factor: 1.25, condition: "loyalty", enabled: true },
];

// ── Badge definitions ──────────────────────────────────────────────────────────

const BADGES = [
  // Creator
  { key: "og",              name: "OG",              description: "Participated during beta",              icon: "Flame",       color: "#f59e0b", category: "creator",   enabled: true },
  { key: "first_drop",      name: "First Drop",      description: "Launched your first collection",        icon: "Package",     color: "#8b5cf6", category: "creator",   enabled: true },
  { key: "sold_out",        name: "Sold Out",        description: "Every edition in a drop was claimed",   icon: "CheckCircle2",color: "#10b981", category: "creator",   enabled: true },
  { key: "remixed",         name: "Remixed",         description: "Someone built on your work",            icon: "GitBranch",   color: "#6366f1", category: "creator",   enabled: true },
  { key: "platinum",        name: "Platinum",        description: "1,000 USDC in total sales",             icon: "TrendingUp",  color: "#94a3b8", category: "creator",   enabled: true },
  { key: "auteur",          name: "Auteur",          description: "Active across 3+ IP types",             icon: "Layers",      color: "#ec4899", category: "creator",   enabled: true },
  { key: "event_host",      name: "Event Host",      description: "Created a ticketed event",              icon: "Ticket",      color: "#f59e0b", category: "creator",   enabled: true },
  { key: "club_founder",    name: "Club Founder",    description: "Started a club",                        icon: "Crown",       color: "#8b5cf6", category: "creator",   enabled: true },
  { key: "coin_creator",    name: "Coin Creator",    description: "Launched a creator coin",               icon: "Coins",       color: "#0ea5e9", category: "creator",   enabled: true },
  // Collector
  { key: "early_believer",  name: "Early Believer",  description: "Among the first 100 on Medialane",      icon: "Star",        color: "#f59e0b", category: "collector", enabled: true },
  { key: "diamond_hands",   name: "Diamond Hands",   description: "Held an asset for 6+ months",           icon: "Gem",         color: "#0ea5e9", category: "collector", enabled: true },
  { key: "taste_maker",     name: "Taste Maker",     description: "Bought an asset that later sold for 5×",icon: "Zap",         color: "#8b5cf6", category: "collector", enabled: true },
  { key: "full_set",        name: "Full Set",        description: "Collected every edition in a drop",     icon: "Award",       color: "#10b981", category: "collector", enabled: true },
  { key: "100_club",        name: "100 Club",        description: "Collected from 100 different creators", icon: "Users",       color: "#6366f1", category: "collector", enabled: true },
  // Community
  { key: "voice",           name: "Voice",           description: "50 on-chain comments",                  icon: "MessageSquare",color: "#0ea5e9", category: "community", enabled: true },
  // Disabled until referral tracking exists.
  { key: "connector",       name: "Connector",       description: "Referred 10 active users",              icon: "Share2",      color: "#10b981", category: "community", enabled: false },
  { key: "supporter",       name: "Supporter",       description: "Made offers on 25 different assets",    icon: "HandCoins",   color: "#f59e0b", category: "community", enabled: true },
  { key: "patron",          name: "Patron",          description: "Sponsored a creator",                   icon: "Handshake",   color: "#10b981", category: "community", enabled: true },
];

// ── Seed ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Seeding reward configuration…");

  // Levels
  for (const l of LEVELS) {
    await prisma.rewardLevel.upsert({
      where: { level: l.level },
      update: { name: l.name, xpRequired: l.xpRequired, badgeColor: l.badgeColor, description: l.description ?? null },
      create: { ...l, description: l.description ?? null },
    });
  }
  console.log(`  ✓ ${LEVELS.length} levels`);

  // Actions
  for (const a of ACTIONS) {
    await prisma.rewardAction.upsert({
      where: { type: a.type },
      update: a,
      create: a,
    });
  }
  console.log(`  ✓ ${ACTIONS.length} action weights`);

  // Multipliers
  for (const m of MULTIPLIERS) {
    await prisma.rewardMultiplier.upsert({
      where: { id: m.condition },   // use condition as stable id for upsert
      update: m,
      create: { id: m.condition, ...m },
    });
  }
  console.log(`  ✓ ${MULTIPLIERS.length} multipliers`);

  // Badges
  for (const b of BADGES) {
    await prisma.badgeDefinition.upsert({
      where: { key: b.key },
      update: b,
      create: b,
    });
  }
  console.log(`  ✓ ${BADGES.length} badge definitions`);

  console.log("Done.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
