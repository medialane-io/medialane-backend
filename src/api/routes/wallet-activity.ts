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

export const STALE_AFTER_MS = 2 * 60 * 1000;

export interface WalletActivityDeps {
  getCursor: (chain: Chain, accountAddress: string) => Promise<{ updatedAt: Date } | null>;
  listActivity: (chain: Chain, accountAddress: string) => Promise<WalletActivityRow[]>;
  enqueueSync: (chain: Chain, accountAddress: string) => void;
}

export function serializeWalletActivity(row: WalletActivityRow) {
  return { ...row, blockNumber: row.blockNumber.toString() };
}

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
