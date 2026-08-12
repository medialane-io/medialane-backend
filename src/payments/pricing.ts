/**
 * Per-request credit cost. Prices are a BUSINESS decision (not derived from
 * gas) — see PricingRule in schema.prisma. This module resolves a request to
 * an actionKey, then to a credit cost via the most specific matching
 * PricingRule row: (actionKey, chain, service) > (actionKey, chain, "ALL")
 * > (actionKey, "ALL", service) > (actionKey, "ALL", "ALL").
 *
 * Returns null for routes that must NOT be metered (account self-service, auth).
 */
import prisma from "../db/client.js";
import { resolveServiceForContract } from "../utils/collection.js";
import { STARKNET_COLLECTION_721_CONTRACT } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("payments:pricing");

// Prefixes that are never metered (managed by the account's own key, no charge).
const UNMETERED_PREFIXES = ["/v1/portal", "/v1/auth"];

// method + prefix → actionKey. First match wins; order most-specific first.
// Each of these is its own dedicated route (not one generic /v1/intents
// endpoint with a `type` field), so the actionKey is resolvable from the
// path alone — no body-peeking needed except for the two service-aware
// actions below.
const ROUTE_ACTIONS: ReadonlyArray<{ method: string; prefix: string; actionKey: string }> = [
  { method: "POST", prefix: "/v1/intents/mint", actionKey: "intent:mint" },
  { method: "POST", prefix: "/v1/intents/create-collection", actionKey: "intent:create-collection" },
  { method: "POST", prefix: "/v1/intents/create-tier", actionKey: "intent:create-tier" },
  { method: "POST", prefix: "/v1/intents/create-coin", actionKey: "intent:create-coin" },
  { method: "POST", prefix: "/v1/intents/launch-coin", actionKey: "intent:launch-coin" },
  { method: "POST", prefix: "/v1/intents/counter-offer", actionKey: "intent:counter-offer" },
  { method: "POST", prefix: "/v1/intents/listing", actionKey: "intent:listing" },
  { method: "POST", prefix: "/v1/intents/offer", actionKey: "intent:offer" },
  { method: "POST", prefix: "/v1/intents/fulfill", actionKey: "intent:fulfill" },
  { method: "POST", prefix: "/v1/intents/cancel", actionKey: "intent:cancel" },
  { method: "POST", prefix: "/v1/intents/checkout", actionKey: "intent:checkout" },
  { method: "POST", prefix: "/v1/intents/sponsorship-offer-open", actionKey: "intent:sponsorship-offer-open" },
  { method: "POST", prefix: "/v1/intents/sponsorship-offer", actionKey: "intent:sponsorship-offer" },
  { method: "POST", prefix: "/v1/intents/sponsorship-bid-retract", actionKey: "intent:sponsorship-bid-retract" },
  { method: "POST", prefix: "/v1/intents/sponsorship-bid-accept", actionKey: "intent:sponsorship-bid-accept" },
  { method: "POST", prefix: "/v1/intents/sponsorship-bid", actionKey: "intent:sponsorship-bid" },
  { method: "POST", prefix: "/v1/intents/sponsorship-proposal-withdraw", actionKey: "intent:sponsorship-proposal-withdraw" },
  { method: "POST", prefix: "/v1/intents/sponsorship-proposal-accept", actionKey: "intent:sponsorship-proposal-accept" },
  { method: "POST", prefix: "/v1/intents/sponsorship-proposal-reject", actionKey: "intent:sponsorship-proposal-reject" },
  { method: "POST", prefix: "/v1/intents/sponsorship-proposal", actionKey: "intent:sponsorship-proposal" },
  // Real Pinata pin cost, previously falling through to the "read" default
  // (1 credit) unpriced. "/v1/metadata/upload-file" never collides with the
  // "/v1/metadata/upload" prefix match below — startsWith requires a "/"
  // boundary and "-file" isn't one.
  { method: "POST", prefix: "/v1/metadata/upload-file", actionKey: "metadata:upload-file" },
  { method: "POST", prefix: "/v1/metadata/upload", actionKey: "metadata:upload-json" },
  { method: "GET", prefix: "/v1/prices", actionKey: "price:read" },
  { method: "GET", prefix: "/v1/tickets", actionKey: "tickets:read-onchain" },
  { method: "GET", prefix: "/v1/club", actionKey: "club:read-onchain" },
  { method: "GET", prefix: "/v1/ipnft", actionKey: "ipnft:read-onchain" },
  { method: "POST", prefix: "/v1/rpc/meter", actionKey: "rpc:call" },
  { method: "POST", prefix: "/v1/paymaster/invoke/build", actionKey: "paymaster:invoke-build" },
  { method: "POST", prefix: "/v1/paymaster/invoke/execute", actionKey: "paymaster:invoke-execute" },
  { method: "POST", prefix: "/v1/paymaster/deploy/build", actionKey: "paymaster:deploy-build" },
  { method: "POST", prefix: "/v1/paymaster/deploy/execute", actionKey: "paymaster:deploy-execute" },
  { method: "POST", prefix: "/v1/swap/quote/meter", actionKey: "swap:quote" },
  { method: "POST", prefix: "/v1/swap/build/meter", actionKey: "swap:build" },
];

// actionKeys whose price MAY vary by service — the only ones worth the extra
// resolution work. Everything else prices by (actionKey, chain) alone.
// mint/create-collection resolve service via a Collection lookup (the request
// only carries a contract address); create-tier's body already names the
// service directly, so it's read straight off the body, no DB lookup.
const SERVICE_AWARE_ACTIONS = new Set(["intent:mint", "intent:create-collection"]);
const SERVICE_FROM_BODY_ACTIONS = new Set(["intent:create-tier"]);

const DEFAULT_ACTION_KEY = "read";
const DEFAULT_CHAIN = "STARKNET";

// Safety-net defaults if the table is empty/unseeded — metering must never
// throw or silently charge 0 because an admin hasn't seeded prices yet.
const FALLBACK_COST: Record<string, number> = {
  read: 1,
  "intent:mint": 5,
  "intent:create-collection": 5,
  "intent:create-tier": 5,
  "intent:create-coin": 5,
  "intent:launch-coin": 5,
  "intent:counter-offer": 5,
  "intent:listing": 5,
  "intent:offer": 5,
  "intent:fulfill": 5,
  "intent:cancel": 5,
  "intent:checkout": 5,
  "intent:sponsorship-offer": 5,
  "intent:sponsorship-offer-open": 5,
  "intent:sponsorship-bid": 5,
  "intent:sponsorship-bid-retract": 5,
  "intent:sponsorship-bid-accept": 5,
  "intent:sponsorship-proposal": 5,
  "intent:sponsorship-proposal-withdraw": 5,
  "intent:sponsorship-proposal-accept": 5,
  "intent:sponsorship-proposal-reject": 5,
  // Closes the gap immediately on deploy, before pricing.config.js's real
  // numbers are applied — better than silently metering these at 1 credit.
  "metadata:upload-json": 3,
  "metadata:upload-file": 8,
  "price:read": 1,
  "tickets:read-onchain": 1,
  "club:read-onchain": 1,
  "ipnft:read-onchain": 1,
  "rpc:call": 1,
  // Sponsored-gas calls: execute is where AVNU actually pays real gas, priced
  // at the same tier as other write intents (mint/listing/offer/... = 5).
  // build only constructs typed data (no gas committed yet) but still costs
  // an AVNU API call, so it's priced at the cheap "read-equivalent" tier —
  // NOT free, per the "no free endpoints" rule. Tune against real AVNU
  // per-tx cost once volume data exists; these are safety-net defaults.
  "paymaster:invoke-build": 1,
  "paymaster:invoke-execute": 5,
  "paymaster:deploy-build": 1,
  "paymaster:deploy-execute": 5,
  // AVNU swap-quote/build calls backing the auto-swap-to-purchase flow.
  // Same "not free" reasoning as the paymaster tier above — quote is a
  // cheap read-equivalent call, build does real route-building work at
  // AVNU so it's priced one tier up. Safety-net defaults, tune with volume.
  "swap:quote": 1,
  "swap:build": 2,
};

export function resolveActionKey(method: string, path: string): string | null {
  if (UNMETERED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    return null;
  }
  for (const rule of ROUTE_ACTIONS) {
    if (rule.method !== method.toUpperCase()) continue;
    if (path === rule.prefix || path.startsWith(rule.prefix + "/")) {
      return rule.actionKey;
    }
  }
  return DEFAULT_ACTION_KEY;
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// PricingRule is small (tens of rows) and read on every metered request, so
// it's fully cached rather than round-tripped per call. Refreshes on a timer
// and can be invalidated immediately after an admin write.

type RuleMap = Map<string, number>; // `${actionKey}::${chain}::${service}` -> credits

let cache: RuleMap | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

function ruleCacheKey(actionKey: string, chain: string, service: string): string {
  return `${actionKey}::${chain}::${service}`;
}

async function loadRules(): Promise<RuleMap> {
  const rows = await prisma.pricingRule.findMany({
    select: { actionKey: true, chain: true, service: true, credits: true },
  });
  const map: RuleMap = new Map();
  for (const r of rows) {
    map.set(ruleCacheKey(r.actionKey, r.chain, r.service), r.credits);
  }
  return map;
}

async function getRules(): Promise<RuleMap> {
  const stale = !cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS;
  if (stale) {
    try {
      cache = await loadRules();
      cacheLoadedAt = Date.now();
    } catch (err) {
      log.error({ err }, "failed to load PricingRule — using fallback costs");
      if (!cache) cache = new Map(); // first-load failure: empty cache, fallback table covers it
    }
  }
  return cache!;
}

/** Call after any admin write to PricingRule so changes apply immediately. */
export function invalidatePricingCache(): void {
  cache = null;
}

function resolveCost(rules: RuleMap, actionKey: string, chain: string, service: string): number {
  const candidates = [
    ruleCacheKey(actionKey, chain, service),
    ruleCacheKey(actionKey, chain, "ALL"),
    ruleCacheKey(actionKey, "ALL", service),
    ruleCacheKey(actionKey, "ALL", "ALL"),
  ];
  for (const key of candidates) {
    const hit = rules.get(key);
    if (hit !== undefined) return hit;
  }
  return FALLBACK_COST[actionKey] ?? 1;
}

/**
 * Resolve the service a mint/create-collection intent targets, so pricing
 * can vary per service (e.g. mip-erc721 vs ip-erc721 today; mip-erc1155 the
 * moment edition minting routes through the same intent shape). Omitted
 * collectionContract defaults to the shared IP-Collection registry, same as
 * the intent builder itself (orchestrator/intent.ts resolveCollectionContract).
 * Never throws — a lookup miss just falls back to service "ALL".
 */
async function resolveMintService(chain: string, collectionContractRaw?: string): Promise<string> {
  try {
    // resolveServiceForContract normalizes internally — pass the raw address straight through.
    const contractAddress = collectionContractRaw ?? STARKNET_COLLECTION_721_CONTRACT;
    const service = await resolveServiceForContract(prisma, chain as never, contractAddress);
    return service ?? "ALL";
  } catch (err) {
    log.warn({ err }, "mint service resolution failed — pricing falls back to ALL");
    return "ALL";
  }
}

export interface CostContext {
  chain?: string;
  /** Only called for service-aware actions (intent:mint, intent:create-collection). */
  getBody?: () => Promise<{ collectionContract?: string; service?: string } | null>;
}

export async function costForRequest(method: string, path: string, ctx: CostContext = {}): Promise<number | null> {
  const actionKey = resolveActionKey(method, path);
  if (actionKey === null) return null;

  const chain = ctx.chain ?? DEFAULT_CHAIN;
  let service = "ALL";
  if (ctx.getBody && (SERVICE_AWARE_ACTIONS.has(actionKey) || SERVICE_FROM_BODY_ACTIONS.has(actionKey))) {
    const body = await ctx.getBody().catch(() => null);
    service = SERVICE_FROM_BODY_ACTIONS.has(actionKey)
      ? body?.service ?? "ALL"
      : await resolveMintService(chain, body?.collectionContract);
  }

  const rules = await getRules();
  return resolveCost(rules, actionKey, chain, service);
}

/**
 * Public cost table for the x402 discovery endpoint. Reflects live
 * PricingRule state. Never throws — discovery must stay up even if the DB
 * is unreachable, since agents rely on it to learn how to pay at all; a DB
 * error degrades to the hardcoded fallback table instead of a 500.
 */
export async function pricingTable(): Promise<{
  default: number;
  rules: Array<{ actionKey: string; chain: string; service: string; credits: number }>;
  unmetered: string[];
}> {
  let rows: Array<{ actionKey: string; chain: string; service: string; credits: number }> = [];
  try {
    rows = await prisma.pricingRule.findMany({
      orderBy: [{ actionKey: "asc" }, { chain: "asc" }, { service: "asc" }],
      select: { actionKey: true, chain: true, service: true, credits: true },
    });
  } catch (err) {
    log.error({ err }, "failed to load PricingRule for discovery — advertising fallback only");
  }
  return {
    default: resolveCost(await getRules(), DEFAULT_ACTION_KEY, DEFAULT_CHAIN, "ALL"),
    rules: rows,
    unmetered: UNMETERED_PREFIXES,
  };
}
