import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { worker } from "./worker.js";
import { createLogger } from "../utils/logger.js";
import { STALE_AFTER_MS } from "../api/routes/wallet-activity.js";

const log = createLogger("orchestrator:wallet-activity-refresh");

const CHECK_INTERVAL_MS = 60 * 1000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

export interface WalletActivityRefreshDeps {
  findStaleActive: () => Promise<Array<{ chain: Chain; accountAddress: string }>>;
  enqueueSync: (chain: Chain, accountAddress: string) => void;
}

const productionDeps: WalletActivityRefreshDeps = {
  findStaleActive: () => {
    const now = Date.now();
    return prisma.walletActivityCursor.findMany({
      where: {
        updatedAt: {
          lt: new Date(now - STALE_AFTER_MS),
          gt: new Date(now - ACTIVE_WINDOW_MS),
        },
      },
      select: { chain: true, accountAddress: true },
      take: BATCH_SIZE,
      orderBy: { updatedAt: "asc" },
    });
  },
  enqueueSync: (chain, accountAddress) => worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain, accountAddress }),
};

export async function runWalletActivityRefreshOnce(deps: WalletActivityRefreshDeps): Promise<void> {
  const stale = await deps.findStaleActive();
  if (stale.length === 0) return;
  log.info({ count: stale.length }, "Refreshing stale wallet-activity cursors");
  for (const { chain, accountAddress } of stale) {
    deps.enqueueSync(chain, accountAddress);
  }
}

export async function startWalletActivityRefreshLoop(
  deps: WalletActivityRefreshDeps = productionDeps,
): Promise<void> {
  log.info("Wallet-activity refresh loop starting...");
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
    try {
      await runWalletActivityRefreshOnce(deps);
    } catch (err) {
      log.error({ err }, "Wallet-activity refresh loop error");
    }
  }
}
