import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import type { Chain, WalletActivityType } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { worker } from "../../orchestrator/worker.js";

export interface WalletActivityRow {
  id: string;
  chain: Chain;
  accountAddress: string;
  type: WalletActivityType;
  txHash: string;
  blockNumber: bigint;
  timestamp: Date;
  tokenAddress: string | null;
  amount: string | null;
  counterparty: string | null;
  tokenInAddress: string | null;
  amountIn: string | null;
  tokenOutAddress: string | null;
  amountOut: string | null;
  createdAt: Date;
}

/** How long a cursor is trusted before a fresh background sync is enqueued
 * on read. Matches WALLET_ACTIVITY_REFRESH_INTERVAL_MS in the periodic
 * refresh loop (walletActivityRefresh.ts) — both exist to answer the same
 * question ("is this account's data fresh enough?"), so they must agree. */
export const STALE_AFTER_MS = 2 * 60 * 1000;

export interface WalletActivityDeps {
  getCursor: (chain: Chain, accountAddress: string) => Promise<{ updatedAt: Date } | null>;
  listActivity: (chain: Chain, accountAddress: string) => Promise<WalletActivityRow[]>;
  enqueueSync: (chain: Chain, accountAddress: string) => void;
}

/**
 * Prisma's `blockNumber` is a native BigInt — Hono's `c.json()` calls
 * `JSON.stringify` under the hood, which throws on BigInt unconditionally.
 * Same pitfall as `serializeOrder` (CLAUDE.md), same fix: stringify it.
 */
export function serializeWalletActivity(row: WalletActivityRow) {
  return { ...row, blockNumber: row.blockNumber.toString() };
}

/**
 * A plain read like any other /v1 endpoint — no wallet-ownership check.
 * Transaction history is public on-chain data (any block explorer shows it
 * for any address with no signature), so there is nothing here to protect
 * beyond the standard apiKeyGate every /v1/* route already goes through.
 * Freshness is handled by enqueueing a background sync when the cursor is
 * missing or stale, never by blocking the request on a live RPC crawl.
 */
export function createWalletActivityRoutes(deps: WalletActivityDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const addressParam = c.req.query("address");
    if (!addressParam) return c.json({ error: "address is required" }, 400);
    const chain = (c.req.query("chain") as Chain | undefined) ?? "STARKNET";
    const address = normalizeAddress(chain, addressParam);

    const cursor = await deps.getCursor(chain, address);
    const isStale = !cursor || Date.now() - cursor.updatedAt.getTime() > STALE_AFTER_MS;
    if (isStale) deps.enqueueSync(chain, address);

    const rows = await deps.listActivity(chain, address);
    return c.json({ data: rows.map(serializeWalletActivity) });
  });

  return app;
}

const productionDeps: WalletActivityDeps = {
  getCursor: (chain, accountAddress) =>
    prisma.walletActivityCursor.findUnique({
      where: { chain_accountAddress: { chain, accountAddress } },
      select: { updatedAt: true },
    }),
  listActivity: (chain, accountAddress) =>
    prisma.walletActivity.findMany({ where: { chain, accountAddress }, orderBy: { timestamp: "desc" } }),
  enqueueSync: (chain, accountAddress) => worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain, accountAddress }),
};

export const walletActivityRoutes = createWalletActivityRoutes(productionDeps);
