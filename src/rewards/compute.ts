/**
 * Rewards compute engine — retroactive XP + badge computation.
 * Reads all historical indexed data, applies DAO-configured action weights,
 * daily caps, and multipliers, then rebuilds UserScore + PointEvent + UserBadge.
 *
 * Runs from two places: the orchestrator's scheduled loop and the admin
 * endpoint (both via runComputeGuarded in orchestrator/rewardsCompute.ts),
 * plus the CLI wrapper src/scripts/compute-rewards.ts.
 *
 * Safe to re-run: rebuilds PointEvent / UserBadge / UserScore atomically.
 */

import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { Prisma } from "@prisma/client";
import { normalizeAddress } from "../utils/starknet.js";
import { createLogger } from "../utils/logger.js";
import { mintActionForService, creationActionForService } from "./partition.js";

const log = createLogger("rewards:compute");

// ZERO address — mints come from here
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Beta period end: platform launched publicly after this (exclusive)
// All activity before this date qualifies for the beta_tester multiplier.
const BETA_END = new Date("2026-12-31T00:00:00Z");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActionConfig {
  type: string;
  xp: number;
  dailyCap: number | null;
  minValueUsdc: number | null;
}

interface MultiplierConfig {
  condition: string;
  factor: number;
}

// Sorted ascending by level — used to search the current level
interface LevelConfig {
  level: number;
  xpRequired: number;
}

// Raw event ready to be aggregated (before daily-cap enforcement)
export interface RawEvent {
  address: string;
  actionType: string;
  xp: number;
  txHash: string | null;
  date: string; // "YYYY-MM-DD" for daily cap grouping
  metadata?: Record<string, unknown>;
}

export interface ComputeSummary {
  dryRun: boolean;
  addresses: number;
  events: number;
  badgeGrants: number;
  top10: { address: string; totalXp: number; level: number }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function levelForXp(xp: number, levels: LevelConfig[]): number {
  let level = 1;
  for (const l of levels) {
    if (xp >= l.xpRequired) level = l.level;
    else break;
  }
  return level;
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadConfig() {
  const [actions, multipliers, levels] = await Promise.all([
    prisma.rewardAction.findMany({ where: { enabled: true } }),
    prisma.rewardMultiplier.findMany({ where: { enabled: true } }),
    prisma.rewardLevel.findMany({ orderBy: { level: "asc" } }),
  ]);
  const actionMap = new Map<string, ActionConfig>(
    actions.map((a) => [a.type, { type: a.type, xp: a.xp, dailyCap: a.dailyCap, minValueUsdc: a.minValueUsdc }])
  );
  return { actionMap, multipliers, levels };
}

// Returns a Set of normalized addresses of the first N distinct users by earliest activity
async function firstNUsers(n: number): Promise<Set<string>> {
  // "User" = anyone who ever placed an order or received a non-mint transfer
  const rows = await prisma.$queryRaw<{ address: string; earliest: Date }[]>`
    SELECT address, MIN(ts) AS earliest FROM (
      SELECT offerer AS address, "createdAt" AS ts FROM "Order"
      UNION ALL
      SELECT "toAddress" AS address, "createdAt" AS ts FROM "Transfer" WHERE "fromAddress" != ${ZERO}
    ) sub
    GROUP BY address
    ORDER BY earliest ASC
    LIMIT ${n}
  `;
  return new Set(rows.map((r) => normalizeAddress("STARKNET", r.address)));
}

// contractAddress → service, for the partition invariant (see partition.ts)
async function loadServiceMap(): Promise<Map<string, string>> {
  const cols = await prisma.collection.findMany({
    select: { contractAddress: true, service: true },
  });
  return new Map(cols.map((c) => [c.contractAddress, c.service]));
}

// ── Event gatherers (one per action type) ─────────────────────────────────────

async function gatherCompleteProfile(xp: number): Promise<RawEvent[]> {
  // Profile data lives on AccountProfile (accountId-keyed); the rewards engine
  // is address-keyed, so resolve each account's wallet address.
  const profiles = await prisma.accountProfile.findMany({
    where: { OR: [{ bio: { not: null } }, { avatarImage: { not: null } }] },
    select: {
      createdAt: true,
      account: { select: { identities: { where: { scheme: IDENTITY_SCHEME.WALLET }, select: { address: true }, take: 1 } } },
    },
  });
  return profiles
    .filter((p) => p.account.identities[0]?.address)
    .map((p) => ({
      address: normalizeAddress("STARKNET", p.account.identities[0]!.address!),
      actionType: "complete_profile",
      xp,
      txHash: null,
      date: p.createdAt.toISOString().slice(0, 10),
    }));
}

// Classifies every mint Transfer by the collection's service (partition
// invariant): issuance mints → mint_asset, ticket buys → buy_ticket, club
// joins → join_club. Pop/drop/external mints emit nothing here.
async function gatherMints(
  actionMap: Map<string, ActionConfig>,
  serviceMap: Map<string, string>
): Promise<RawEvent[]> {
  const mints = await prisma.transfer.findMany({
    where: { fromAddress: ZERO },
    select: { toAddress: true, txHash: true, createdAt: true, contractAddress: true },
  });
  const events: RawEvent[] = [];
  for (const m of mints) {
    const actionType = mintActionForService(serviceMap.get(m.contractAddress));
    if (!actionType) continue;
    const action = actionMap.get(actionType);
    if (!action) continue;
    events.push({
      address: normalizeAddress("STARKNET", m.toAddress),
      actionType,
      xp: action.xp,
      txHash: m.txHash,
      date: m.createdAt.toISOString().slice(0, 10),
    });
  }
  return events;
}

// Classifies every collection creation by service: issuance → create_collection,
// tickets → create_ticket_collection, clubs → create_club. Drop/pop creations
// emit nothing here (launch_launchpad owns them); external ones score nothing.
async function gatherCreations(actionMap: Map<string, ActionConfig>): Promise<RawEvent[]> {
  const collections = await prisma.collection.findMany({
    where: { owner: { not: null }, deletedAt: null },
    select: { owner: true, createdAt: true, contractAddress: true, service: true },
  });
  const events: RawEvent[] = [];
  for (const c of collections) {
    if (!c.owner) continue;
    const actionType = creationActionForService(c.service);
    if (!actionType) continue;
    const action = actionMap.get(actionType);
    if (!action) continue;
    events.push({
      address: normalizeAddress("STARKNET", c.owner),
      actionType,
      xp: action.xp,
      txHash: null,
      date: c.createdAt.toISOString().slice(0, 10),
      metadata: { collection: c.contractAddress },
    });
  }
  return events;
}

async function gatherLaunchLaunchpad(xp: number): Promise<RawEvent[]> {
  // Launchpad = collection with configured drop or POP conditions
  const [drops, pops] = await Promise.all([
    prisma.dropClaimConditions.findMany({
      select: { collectionAddress: true, createdAt: true },
    }),
    // POP = collection that has at least one PopAllowlist entry
    prisma.popAllowlist.findMany({
      distinct: ["collectionAddress"],
      select: { collectionAddress: true },
    }),
  ]);

  // Resolve owner for each launchpad collection
  const allContracts = [
    ...drops.map((d) => ({ contract: d.collectionAddress, createdAt: d.createdAt })),
    ...pops.map((p) => ({ contract: p.collectionAddress, createdAt: new Date() })),
  ];

  const contractSet = [...new Set(allContracts.map((c) => c.contract))];
  const collections = await prisma.collection.findMany({
    where: { contractAddress: { in: contractSet } },
    select: { contractAddress: true, owner: true, createdAt: true },
  });
  const ownerMap = new Map(collections.map((c) => [c.contractAddress, c]));

  const events: RawEvent[] = [];
  for (const { contract, createdAt } of allContracts) {
    const col = ownerMap.get(contract);
    if (!col?.owner) continue;
    events.push({
      address: normalizeAddress("STARKNET", col.owner),
      actionType: "launch_launchpad",
      xp,
      txHash: null,
      date: createdAt.toISOString().slice(0, 10),
      metadata: { collection: contract },
    });
  }
  return events;
}

async function gatherCreateRemix(xp: number): Promise<RawEvent[]> {
  const remixes = await prisma.remixOffer.findMany({
    where: { requesterAddress: { not: null } },
    select: { requesterAddress: true, createdAt: true, id: true },
  });
  return remixes.map((r) => ({
    address: normalizeAddress("STARKNET", r.requesterAddress!),
    actionType: "create_remix",
    xp,
    txHash: null,
    date: r.createdAt.toISOString().slice(0, 10),
    metadata: { remixOfferId: r.id },
  }));
}

async function gatherListAsset(xp: number, minValueUsdc: number | null): Promise<RawEvent[]> {
  // Listing = Order where offerItemType is ERC721 or ERC1155
  const listings = await prisma.order.findMany({
    where: { offerItemType: { in: ["ERC721", "ERC1155"] } },
    select: { offerer: true, createdAt: true, orderHash: true, priceRaw: true, currencySymbol: true },
  });

  return listings
    .filter((o) => {
      if (!minValueUsdc) return true;
      if (!o.priceRaw) return false;
      // Only USDC/USDT listings pass the minimum; ETH/STRK skip filter for now
      const sym = o.currencySymbol?.toUpperCase() ?? "";
      if (!["USDC", "USDT"].includes(sym)) return true;
      const val = parseFloat(o.priceRaw);
      return val >= minValueUsdc;
    })
    .map((o) => ({
      address: normalizeAddress("STARKNET", o.offerer),
      actionType: "list_asset",
      xp,
      txHash: null,
      date: o.createdAt.toISOString().slice(0, 10),
      metadata: { orderHash: o.orderHash },
    }));
}

async function gatherBuyAsset(xp: number, minValueUsdc: number | null): Promise<RawEvent[]> {
  // Buy = OrderFill where underlying order is a listing (ERC721/1155 offer)
  const fills = await prisma.orderFill.findMany({
    where: { order: { offerItemType: { in: ["ERC721", "ERC1155"] } } },
    include: { order: { select: { offerItemType: true } } },
  });

  return fills
    .filter((f) => {
      if (!minValueUsdc) return true;
      if (!f.priceRaw) return false;
      const sym = f.currencySymbol?.toUpperCase() ?? "";
      if (!["USDC", "USDT"].includes(sym)) return true;
      return parseFloat(f.priceRaw) >= minValueUsdc;
    })
    .map((f) => ({
      address: normalizeAddress("STARKNET", f.fulfiller),
      actionType: "buy_asset",
      xp,
      txHash: f.txHash,
      date: f.createdAt.toISOString().slice(0, 10),
    }));
}

async function gatherMakeOffer(xp: number, minValueUsdc: number | null): Promise<RawEvent[]> {
  // Offer/bid = Order where offerItemType is ERC20
  const offers = await prisma.order.findMany({
    where: { offerItemType: "ERC20" },
    select: { offerer: true, createdAt: true, orderHash: true, priceRaw: true, currencySymbol: true },
  });

  return offers
    .filter((o) => {
      if (!minValueUsdc) return true;
      if (!o.priceRaw) return false;
      const sym = o.currencySymbol?.toUpperCase() ?? "";
      if (!["USDC", "USDT"].includes(sym)) return true;
      return parseFloat(o.priceRaw) >= minValueUsdc;
    })
    .map((o) => ({
      address: normalizeAddress("STARKNET", o.offerer),
      actionType: "make_offer",
      xp,
      txHash: null,
      date: o.createdAt.toISOString().slice(0, 10),
      metadata: { orderHash: o.orderHash },
    }));
}

async function gatherCounterOffer(xp: number): Promise<RawEvent[]> {
  // Counter offer = Order with a parentOrderHash set
  const counters = await prisma.order.findMany({
    where: { parentOrderHash: { not: null } },
    select: { offerer: true, createdAt: true, orderHash: true },
  });
  return counters.map((o) => ({
    address: normalizeAddress("STARKNET", o.offerer),
    actionType: "counter_offer",
    xp,
    txHash: null,
    date: o.createdAt.toISOString().slice(0, 10),
    metadata: { orderHash: o.orderHash },
  }));
}

async function gatherOfferAccepted(sellerXp: number, buyerXp: number): Promise<RawEvent[]> {
  // Bid fills: OrderFill on an ERC20-offer order
  const fills = await prisma.orderFill.findMany({
    where: { order: { offerItemType: "ERC20" } },
    select: {
      fulfiller: true,
      createdAt: true,
      txHash: true,
      order: { select: { offerer: true, considerationRecipient: true } },
    },
  });

  const events: RawEvent[] = [];
  for (const f of fills) {
    // Seller = consideration recipient (receives ERC-20 payment)
    if (f.order.considerationRecipient) {
      events.push({
        address: normalizeAddress("STARKNET", f.order.considerationRecipient),
        actionType: "offer_accepted_seller",
        xp: sellerXp,
        txHash: f.txHash,
        date: f.createdAt.toISOString().slice(0, 10),
      });
    }
    // Buyer = the original offerer whose bid was accepted
    events.push({
      address: normalizeAddress("STARKNET", f.order.offerer),
      actionType: "offer_accepted_buyer",
      xp: buyerXp,
      txHash: f.txHash,
      date: f.createdAt.toISOString().slice(0, 10),
    });
  }
  return events;
}

async function gatherClaimPop(xp: number): Promise<RawEvent[]> {
  // POP claim = Transfer to address from a collection that has PopAllowlist entries
  const popContracts = await prisma.popAllowlist.findMany({
    distinct: ["collectionAddress"],
    select: { collectionAddress: true },
  });
  const popSet = new Set(popContracts.map((p) => p.collectionAddress));

  const transfers = await prisma.transfer.findMany({
    where: { contractAddress: { in: [...popSet] } },
    select: { toAddress: true, txHash: true, createdAt: true },
  });

  return transfers.map((t) => ({
    address: normalizeAddress("STARKNET", t.toAddress),
    actionType: "claim_pop",
    xp,
    txHash: t.txHash,
    date: t.createdAt.toISOString().slice(0, 10),
  }));
}

async function gatherClaimDrop(xp: number): Promise<RawEvent[]> {
  // Drop claim = Transfer to address from a collection that has DropClaimConditions
  const dropContracts = await prisma.dropClaimConditions.findMany({
    select: { collectionAddress: true },
  });
  const dropSet = new Set(dropContracts.map((d) => d.collectionAddress));

  const transfers = await prisma.transfer.findMany({
    where: { contractAddress: { in: [...dropSet] }, fromAddress: { not: ZERO } },
    select: { toAddress: true, txHash: true, createdAt: true },
  });

  return transfers.map((t) => ({
    address: normalizeAddress("STARKNET", t.toAddress),
    actionType: "claim_drop",
    xp,
    txHash: t.txHash,
    date: t.createdAt.toISOString().slice(0, 10),
  }));
}

async function gatherComments(xp: number): Promise<RawEvent[]> {
  const comments = await prisma.comment.findMany({
    where: { isHidden: false },
    select: { author: true, txHash: true, createdAt: true },
  });
  return comments.map((c) => ({
    address: normalizeAddress("STARKNET", c.author),
    actionType: "comment",
    xp,
    txHash: c.txHash ?? null,
    date: c.createdAt.toISOString().slice(0, 10),
  }));
}

// ── Daily cap enforcement ─────────────────────────────────────────────────────

export function applyCaps(rawEvents: RawEvent[], actionMap: Map<string, ActionConfig>): RawEvent[] {
  // Group by (address, actionType, date) and enforce daily cap
  const counters = new Map<string, number>();
  const result: RawEvent[] = [];

  for (const ev of rawEvents) {
    const action = actionMap.get(ev.actionType);
    if (!action) continue;

    const key = `${ev.address}|${ev.actionType}|${ev.date}`;
    const current = counters.get(key) ?? 0;

    if (action.dailyCap !== null && current >= action.dailyCap) continue;

    counters.set(key, current + 1);
    result.push(ev);
  }
  return result;
}

// ── Multiplier resolution ─────────────────────────────────────────────────────

function resolveMultiplier(
  address: string,
  multipliers: MultiplierConfig[],
  isBetaUser: boolean,
  first100: Set<string>
): number {
  let factor = 1.0;
  for (const m of multipliers) {
    if (m.condition === "beta_tester" && isBetaUser) factor = Math.max(factor, m.factor);
    if (m.condition === "first_100" && first100.has(address)) factor = Math.max(factor, m.factor);
    // "loyalty" multiplier: applied manually by admin — skip in auto-compute
  }
  return factor;
}

// ── Badge awarding ────────────────────────────────────────────────────────────

async function computeBadges(
  scoresByAddress: Map<string, { totalXp: number; breakdown: Record<string, number> }>,
  first100: Set<string>
): Promise<Map<string, string[]>> {
  const badges = new Map<string, string[]>();

  const award = (address: string, key: string) => {
    const list = badges.get(address) ?? [];
    list.push(key);
    badges.set(address, list);
  };

  // OG — beta participation: anyone with any XP before beta end
  const allAddresses = [...scoresByAddress.keys()];
  for (const address of allAddresses) {
    award(address, "og");
  }

  // First 100
  for (const address of first100) {
    if (scoresByAddress.has(address)) {
      // "early_believer" awarded separately below
    }
  }

  // Creator badges
  const collectionsByOwner = await prisma.collection.groupBy({
    by: ["owner"],
    _count: { id: true },
    where: { owner: { not: null }, deletedAt: null },
  });
  for (const row of collectionsByOwner) {
    if (!row.owner) continue;
    const addr = normalizeAddress("STARKNET", row.owner);
    if (row._count.id >= 1) award(addr, "first_drop");
  }

  // Sold Out — every edition claimed
  const drops = await prisma.dropClaimConditions.findMany({
    select: { collectionAddress: true, maxSupply: true },
  });
  for (const drop of drops) {
    const claimed = await prisma.transfer.count({
      where: { contractAddress: drop.collectionAddress, fromAddress: { not: ZERO } },
    });
    if (BigInt(claimed) >= BigInt(drop.maxSupply)) {
      const col = await prisma.collection.findFirst({
        where: { contractAddress: drop.collectionAddress },
        select: { owner: true },
      });
      if (col?.owner) award(normalizeAddress("STARKNET", col.owner), "sold_out");
    }
  }

  // Remixed — someone built on your work
  const remixedCreators = await prisma.remixOffer.findMany({
    where: { status: { in: ["APPROVED", "COMPLETED", "SELF_MINTED"] } },
    select: { creatorAddress: true },
    distinct: ["creatorAddress"],
  });
  for (const r of remixedCreators) {
    award(normalizeAddress("STARKNET", r.creatorAddress), "remixed");
  }

  // Platinum — 1000 USDC in total sales
  const sales = await prisma.orderFill.findMany({
    where: { currencySymbol: { in: ["USDC", "USDT"] } },
    include: { order: { select: { considerationRecipient: true } } },
  });
  const salesByAddress = new Map<string, number>();
  for (const s of sales) {
    const seller = s.order?.considerationRecipient;
    if (!seller) continue;
    const addr = normalizeAddress("STARKNET", seller);
    const val = parseFloat(s.priceRaw ?? "0");
    salesByAddress.set(addr, (salesByAddress.get(addr) ?? 0) + val);
  }
  for (const [addr, total] of salesByAddress) {
    if (total >= 1000) award(addr, "platinum");
  }

  // Voice — 50 on-chain comments
  const commentCounts = await prisma.comment.groupBy({
    by: ["author"],
    _count: { id: true },
    where: { isHidden: false },
  });
  for (const row of commentCounts) {
    if (row._count.id >= 50) award(normalizeAddress("STARKNET", row.author), "voice");
  }

  // Connector — referred 10 active users (not tracked yet, skip)

  // Supporter — made offers on 25 different assets
  const offersByOfferer = await prisma.order.groupBy({
    by: ["offerer", "nftTokenId"],
    where: { offerItemType: "ERC20", nftTokenId: { not: null } },
    _count: { id: true },
  });
  const distinctAssetsByOfferer = new Map<string, Set<string>>();
  for (const row of offersByOfferer) {
    const addr = normalizeAddress("STARKNET", row.offerer);
    const set = distinctAssetsByOfferer.get(addr) ?? new Set();
    if (row.nftTokenId) set.add(row.nftTokenId);
    distinctAssetsByOfferer.set(addr, set);
  }
  for (const [addr, assetSet] of distinctAssetsByOfferer) {
    if (assetSet.size >= 25) award(addr, "supporter");
  }

  // 100 Club — collected from 100 different creators
  const tokenOwnerships = await prisma.transfer.findMany({
    where: { fromAddress: { not: ZERO } },
    select: { toAddress: true, contractAddress: true },
    distinct: ["toAddress", "contractAddress"],
  });
  const creatorsByCollector = new Map<string, Set<string>>();
  const contractOwnerMap = new Map<string, string | null>();
  for (const t of tokenOwnerships) {
    const addr = normalizeAddress("STARKNET", t.toAddress);
    if (!contractOwnerMap.has(t.contractAddress)) {
      // Will be populated below
      contractOwnerMap.set(t.contractAddress, null);
    }
    const set = creatorsByCollector.get(addr) ?? new Set();
    set.add(t.contractAddress);
    creatorsByCollector.set(addr, set);
  }
  // Resolve owners in one query
  const uniqueContracts = [...contractOwnerMap.keys()];
  if (uniqueContracts.length > 0) {
    const cols = await prisma.collection.findMany({
      where: { contractAddress: { in: uniqueContracts } },
      select: { contractAddress: true, owner: true },
    });
    for (const c of cols) contractOwnerMap.set(c.contractAddress, c.owner ?? null);
  }
  for (const [addr, contracts] of creatorsByCollector) {
    const uniqueCreators = new Set([...contracts].map((c) => contractOwnerMap.get(c)).filter(Boolean));
    if (uniqueCreators.size >= 100) award(addr, "100_club");
  }

  // Auteur — active across 3+ IP types
  // IP types inferred from Collection.standard (ERC721 vs ERC1155) and remix activity
  // This is a simplified proxy: creator has collections + remix offers
  for (const address of allAddresses) {
    const bd = scoresByAddress.get(address)!.breakdown;
    let types = 0;
    if ((bd.mint_asset ?? 0) > 0) types++;
    if ((bd.create_collection ?? 0) > 0) types++;
    if ((bd.create_remix ?? 0) > 0) types++;
    if ((bd.launch_launchpad ?? 0) > 0) types++;
    if (types >= 3) award(address, "auteur");
  }

  return badges;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function computeRewards(
  opts: { dryRun?: boolean; skipBadges?: boolean } = {}
): Promise<ComputeSummary> {
  const isDryRun = opts.dryRun ?? false;
  const skipBadges = opts.skipBadges ?? false;

  log.info({ dryRun: isDryRun }, "Computing rewards…");

  const { actionMap, multipliers, levels } = await loadConfig();
  log.info({ actions: actionMap.size, multipliers: multipliers.length, levels: levels.length }, "Config loaded");

  const first100 = await firstNUsers(100);
  log.info({ found: first100.size }, "First 100 users identified");

  const serviceMap = await loadServiceMap();

  // ── Gather all raw events ──────────────────────────────────────────────────
  const allRaw: RawEvent[] = [];

  const gather = async (type: string, fn: () => Promise<RawEvent[]>) => {
    if (!actionMap.has(type)) return;
    const events = await fn();
    allRaw.push(...events);
    log.info({ type, count: events.length }, "Gathered events");
  };

  const a = (type: string) => actionMap.get(type)!;

  await gather("complete_profile",    () => gatherCompleteProfile(a("complete_profile").xp));

  // Mints + creations are classified per collection service internally
  // (mint_asset / buy_ticket / join_club; create_collection / create_ticket_collection / create_club)
  {
    const mintEvents = await gatherMints(actionMap, serviceMap);
    allRaw.push(...mintEvents);
    log.info({ count: mintEvents.length }, "Gathered mint-family events");
    const creationEvents = await gatherCreations(actionMap);
    allRaw.push(...creationEvents);
    log.info({ count: creationEvents.length }, "Gathered creation-family events");
  }

  await gather("launch_launchpad",    () => gatherLaunchLaunchpad(a("launch_launchpad").xp));
  await gather("create_remix",        () => gatherCreateRemix(a("create_remix").xp));
  await gather("list_asset",          () => gatherListAsset(a("list_asset").xp, a("list_asset").minValueUsdc));
  await gather("buy_asset",           () => gatherBuyAsset(a("buy_asset").xp, a("buy_asset").minValueUsdc));
  await gather("make_offer",          () => gatherMakeOffer(a("make_offer").xp, a("make_offer").minValueUsdc));
  await gather("counter_offer",       () => gatherCounterOffer(a("counter_offer").xp));
  await gather("comment",             () => gatherComments(a("comment").xp));

  // offer_accepted handles both seller and buyer variants
  if (actionMap.has("offer_accepted_seller") && actionMap.has("offer_accepted_buyer")) {
    const events = await gatherOfferAccepted(
      a("offer_accepted_seller").xp,
      a("offer_accepted_buyer").xp
    );
    allRaw.push(...events);
    log.info({ count: events.length }, "Gathered offer_accepted events");
  }

  if (actionMap.has("claim_pop"))  allRaw.push(...(await gatherClaimPop(a("claim_pop").xp)));
  if (actionMap.has("claim_drop")) allRaw.push(...(await gatherClaimDrop(a("claim_drop").xp)));

  log.info({ total: allRaw.length }, "Total raw events");

  // ── Apply daily caps ───────────────────────────────────────────────────────
  const cappedEvents = applyCaps(allRaw, actionMap);
  log.info({ count: cappedEvents.length }, "After daily caps");

  // ── Aggregate per address ──────────────────────────────────────────────────
  const scoresByAddress = new Map<string, { totalXp: number; breakdown: Record<string, number> }>();

  for (const ev of cappedEvents) {
    if (!scoresByAddress.has(ev.address)) {
      scoresByAddress.set(ev.address, { totalXp: 0, breakdown: {} });
    }
    const score = scoresByAddress.get(ev.address)!;
    score.breakdown[ev.actionType] = (score.breakdown[ev.actionType] ?? 0) + ev.xp;
  }

  // ── Apply multipliers ──────────────────────────────────────────────────────
  // Beta tester = any current user (platform is still in beta)
  const mConfigs: MultiplierConfig[] = multipliers.map((m) => ({ condition: m.condition, factor: m.factor }));

  for (const [address, score] of scoresByAddress) {
    const isBetaUser = true; // everyone active now is a beta tester
    const multiplier = resolveMultiplier(address, mConfigs, isBetaUser, first100);
    score.totalXp = Math.round(
      Object.values(score.breakdown).reduce((s, x) => s + x, 0) * multiplier
    );
  }

  log.info({ addresses: scoresByAddress.size }, "Unique addresses");

  // ── Compute badges ─────────────────────────────────────────────────────────
  let badgesByAddress = new Map<string, string[]>();
  if (!skipBadges) {
    badgesByAddress = await computeBadges(scoresByAddress, first100);
    log.info(
      { grants: [...badgesByAddress.values()].reduce((s, b) => s + b.length, 0) },
      "Badge grants computed"
    );
  }

  const top10 = [...scoresByAddress.entries()]
    .sort((a, b) => b[1].totalXp - a[1].totalXp)
    .slice(0, 10)
    .map(([address, score]) => ({ address, totalXp: score.totalXp, level: levelForXp(score.totalXp, levels) }));

  const badgeGrants = [...badgesByAddress.values()].reduce((s, b) => s + b.length, 0);

  if (isDryRun) {
    log.info("Dry run complete — no DB writes");
    return { dryRun: true, addresses: scoresByAddress.size, events: cappedEvents.length, badgeGrants, top10 };
  }

  // ── Write to DB ────────────────────────────────────────────────────────────
  log.info("Writing to DB…");

  // Truncate existing computed data
  await prisma.$transaction([
    prisma.pointEvent.deleteMany({}),
    prisma.userBadge.deleteMany({}),
    prisma.userScore.deleteMany({}),
  ]);
  log.info("Cleared existing scores/badges/events");

  // Upsert UserScores
  let scoreCount = 0;
  for (const [address, score] of scoresByAddress) {
    const isBetaUser = true;
    const multiplier = resolveMultiplier(address, mConfigs, isBetaUser, first100);
    const level = levelForXp(score.totalXp, levels);

    await prisma.userScore.upsert({
      where: { address },
      update: { totalXp: score.totalXp, currentLevel: level, breakdown: score.breakdown, computedAt: new Date() },
      create: { address, totalXp: score.totalXp, currentLevel: level, breakdown: score.breakdown },
    });
    scoreCount++;
  }
  log.info({ count: scoreCount }, "Wrote UserScore records");

  // Bulk-insert PointEvents in batches
  const BATCH = 500;
  const pointEvents = cappedEvents.map((ev) => {
    const rawXp = ev.xp;
    const multiplier = resolveMultiplier(ev.address, mConfigs, true, first100);
    return {
      address: ev.address,
      actionType: ev.actionType,
      xp: rawXp,
      multiplier,
      finalXp: Math.round(rawXp * multiplier),
      txHash: ev.txHash ?? undefined,
      metadata: ev.metadata ? (ev.metadata as Prisma.InputJsonValue) : undefined,
    };
  });

  for (let i = 0; i < pointEvents.length; i += BATCH) {
    await prisma.pointEvent.createMany({ data: pointEvents.slice(i, i + BATCH) });
  }
  log.info({ count: pointEvents.length }, "Wrote PointEvent records");

  // Write badges
  if (!skipBadges) {
    const badgeRows: { address: string; badgeKey: string }[] = [];
    for (const [address, keys] of badgesByAddress) {
      for (const key of keys) {
        badgeRows.push({ address, badgeKey: key });
      }
    }
    for (let i = 0; i < badgeRows.length; i += BATCH) {
      await prisma.userBadge.createMany({
        data: badgeRows.slice(i, i + BATCH),
        skipDuplicates: true,
      });
    }
    log.info({ count: badgeRows.length }, "Wrote UserBadge records");
  }

  // Opportunistic accountId backfill — links reputation rows to Accounts where
  // the wallet is known. Activity-only addresses (no Wallet row) stay null.
  const scoresLinked = await prisma.$executeRaw`
    UPDATE "UserScore" us SET "accountId" = w."accountId"
    FROM "Identity" w
    WHERE w.scheme = 'wallet' AND w."chain" = us."chain" AND w."address" = us."address" AND us."accountId" IS DISTINCT FROM w."accountId"
  `;
  const badgesLinked = await prisma.$executeRaw`
    UPDATE "UserBadge" ub SET "accountId" = w."accountId"
    FROM "Identity" w WHERE w.scheme = 'wallet' AND w."address" = ub."address" AND ub."accountId" IS DISTINCT FROM w."accountId"
  `;
  const eventsLinked = await prisma.$executeRaw`
    UPDATE "PointEvent" pe SET "accountId" = w."accountId"
    FROM "Identity" w WHERE w.scheme = 'wallet' AND w."chain" = pe."chain" AND w."address" = pe."address" AND pe."accountId" IS DISTINCT FROM w."accountId"
  `;
  log.info({ scoresLinked, badgesLinked, eventsLinked }, "Linked accountId on reputation rows");

  log.info("Done");
  return { dryRun: false, addresses: scoresByAddress.size, events: cappedEvents.length, badgeGrants, top10 };
}
