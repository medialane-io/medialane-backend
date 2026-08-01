import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import type { Chain, WalletActivityType } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { syncWalletActivityProd } from "../../walletActivity/sync.js";

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

export interface WalletActivityDeps {
  sync: (chain: Chain, accountAddress: string) => Promise<void>;
  listActivity: (chain: Chain, accountAddress: string) => Promise<WalletActivityRow[]>;
}

/**
 * Prisma's `blockNumber` is a native BigInt — Hono's `c.json()` calls
 * `JSON.stringify` under the hood, which throws on BigInt unconditionally.
 * Same pitfall as `serializeOrder` (CLAUDE.md), same fix: stringify it.
 */
export function serializeWalletActivity(row: WalletActivityRow) {
  return { ...row, blockNumber: row.blockNumber.toString() };
}

// identityAuth is applied at mount time (server.ts), not inline here — this
// route only ever depends on `c.get("walletAddress")` already being set by
// whatever wraps it, same separation as apiKeyGate's own mounting.
export function createWalletActivityRoutes(deps: WalletActivityDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const addressParam = c.req.query("address");
    if (!addressParam) return c.json({ error: "address is required" }, 400);
    const chain = (c.req.query("chain") as Chain | undefined) ?? "STARKNET";
    const address = normalizeAddress(chain, addressParam);

    const jwtWallet = c.get("walletAddress") as string;
    if (jwtWallet !== address) return c.json({ error: "Wallet address does not match authenticated session" }, 403);

    await deps.sync(chain, address);
    const rows = await deps.listActivity(chain, address);
    return c.json({ data: rows.map(serializeWalletActivity) });
  });

  return app;
}

const productionDeps: WalletActivityDeps = {
  sync: syncWalletActivityProd,
  listActivity: (chain, accountAddress) =>
    prisma.walletActivity.findMany({ where: { chain, accountAddress }, orderBy: { timestamp: "desc" } }),
};

export const walletActivityRoutes = createWalletActivityRoutes(productionDeps);
