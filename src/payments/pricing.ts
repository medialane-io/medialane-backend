
import { x402Config, USDC_DECIMALS } from "../config/x402.js";
import { PRICING } from "../../pricing.config.js";

export const ROUTE_ACTIONS: ReadonlyArray<{ method: string; prefix: string; actionKey: string; exact?: boolean }> = [
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
  { method: "POST", prefix: "/v1/auth/email/request-code", actionKey: "auth:email-send" },
  { method: "POST", prefix: "/v1/tx/sync", actionKey: "tx:sync" },
  { method: "POST", prefix: "/v1/rpc", actionKey: "rpc:call" },
  { method: "POST", prefix: "/v1/business/provisioning", actionKey: "wallet:deploy", exact: true },
  { method: "POST", prefix: "/v1/business/issuance/emission", actionKey: "issuance:emission", exact: true },
  { method: "POST", prefix: "/v1/paymaster/invoke/build", actionKey: "paymaster:invoke-build" },
  { method: "POST", prefix: "/v1/paymaster/invoke/execute", actionKey: "paymaster:invoke-execute" },
  { method: "POST", prefix: "/v1/paymaster/deploy/build", actionKey: "paymaster:deploy-build" },
  { method: "POST", prefix: "/v1/paymaster/deploy/execute", actionKey: "paymaster:deploy-execute" },
  { method: "POST", prefix: "/v1/swap/quote", actionKey: "swap:quote" },
  { method: "POST", prefix: "/v1/swap/build", actionKey: "swap:build" },
];

const BATCH_UNIT_EXTRACTORS: Record<string, (body: unknown) => number> = {
  "rpc:call": (body) => (Array.isArray(body) ? body.length : 1),
  "issuance:emission": (body) => {
    const recipients = (body as { recipients?: unknown } | null)?.recipients;
    return Array.isArray(recipients) ? recipients.length : 1;
  },
};

const DEFAULT_ACTION_KEY = "read";
const DEFAULT_CHAIN = "STARKNET";

export function resolveActionKey(method: string, path: string): string | null {
  for (const rule of ROUTE_ACTIONS) {
    if (rule.method !== method.toUpperCase()) continue;
    if (rule.exact ? path === rule.prefix : path === rule.prefix || path.startsWith(rule.prefix + "/")) {
      return rule.actionKey;
    }
  }
  return DEFAULT_ACTION_KEY;
}

type RuleMap = Map<string, number>;

function ruleCacheKey(actionKey: string, chain: string, service: string): string {
  return `${actionKey}::${chain}::${service}`;
}

const USD_PER_CREDIT = Number(x402Config.usdcAtomicPerCredit) / 10 ** USDC_DECIMALS;

const PRICE_ROWS = PRICING.map((row) => ({
  actionKey: row.action,
  chain: row.chain ?? "ALL",
  service: row.service ?? "ALL",
  credits: Math.round(row.usd / USD_PER_CREDIT),
})).sort(
  (a, b) => a.actionKey.localeCompare(b.actionKey) || a.chain.localeCompare(b.chain) || a.service.localeCompare(b.service),
);

const RULES: RuleMap = new Map(PRICE_ROWS.map((r) => [ruleCacheKey(r.actionKey, r.chain, r.service), r.credits]));

function resolveCost(rules: RuleMap, actionKey: string, chain: string): number {
  for (const key of [ruleCacheKey(actionKey, chain, "ALL"), ruleCacheKey(actionKey, "ALL", "ALL")]) {
    const hit = rules.get(key);
    if (hit !== undefined) return hit;
  }
  return rules.get(ruleCacheKey(DEFAULT_ACTION_KEY, "ALL", "ALL")) ?? 1;
}

export async function creditsForAction(actionKey: string, chain: string = DEFAULT_CHAIN): Promise<number> {
  return resolveCost(RULES, actionKey, chain);
}

export interface CostContext {
  chain?: string;
  getBody?: () => Promise<unknown>;
}

export interface Charge {
  actionKey: string;
  chain: string;
  service: string;
  unitCredits: number;
  units: number;
}

export async function chargeForRequest(
  method: string,
  path: string,
  ctx: CostContext = {},
): Promise<Charge | null> {
  const actionKey = resolveActionKey(method, path);
  if (actionKey === null) return null;

  const chain = ctx.chain ?? DEFAULT_CHAIN;
  const unitCredits = resolveCost(RULES, actionKey, chain);

  let units = 1;
  const extractor = BATCH_UNIT_EXTRACTORS[actionKey];
  if (ctx.getBody && extractor) {
    const body = await ctx.getBody().catch(() => null);
    units = Math.max(1, extractor(body));
  }

  return { actionKey, chain, service: "ALL", unitCredits, units };
}

export async function pricingTable(): Promise<{
  default: number;
  rules: Array<{ actionKey: string; chain: string; service: string; credits: number }>;
}> {
  return {
    default: resolveCost(RULES, DEFAULT_ACTION_KEY, DEFAULT_CHAIN),
    rules: PRICE_ROWS,
  };
}
