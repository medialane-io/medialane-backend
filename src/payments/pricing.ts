
import prisma from "../db/client.js";
import { resolveServiceForContract } from "../utils/collection.js";
import { STARKNET_COLLECTION_721_CONTRACT } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("payments:pricing");

const UNMETERED_PREFIXES = ["/v1/portal", "/v1/auth"];

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

  { method: "POST", prefix: "/v1/metadata/upload-file", actionKey: "metadata:upload-file" },
  { method: "POST", prefix: "/v1/metadata/upload-directory", actionKey: "metadata:upload-directory" },
  { method: "POST", prefix: "/v1/metadata/upload", actionKey: "metadata:upload-json" },
  { method: "GET", prefix: "/v1/metadata/signed-url", actionKey: "metadata:signed-url" },
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

const SERVICE_AWARE_ACTIONS = new Set(["intent:mint", "intent:create-collection"]);
const SERVICE_FROM_BODY_ACTIONS = new Set(["intent:create-tier"]);

const DEFAULT_ACTION_KEY = "read";
const DEFAULT_CHAIN = "STARKNET";

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

  "metadata:upload-json": 3,
  "metadata:upload-file": 8,
  "metadata:upload-directory": 8,
  "metadata:signed-url": 8,
  "price:read": 1,
  "tickets:read-onchain": 1,
  "club:read-onchain": 1,
  "ipnft:read-onchain": 1,
  "rpc:call": 1,

  "paymaster:invoke-build": 1,
  "paymaster:invoke-execute": 5,
  "paymaster:deploy-build": 1,
  "paymaster:deploy-execute": 5,

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

type RuleMap = Map<string, number>;

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
      if (!cache) cache = new Map();
    }
  }
  return cache!;
}

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

async function resolveMintService(chain: string, collectionContractRaw?: string): Promise<string> {
  try {

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
