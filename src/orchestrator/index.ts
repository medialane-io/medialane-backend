import { reaperLoop } from "./reaper.js";
import { unverifiedAccountsLoop } from "./unverifiedAccounts.js";
import { accountNoticesLoop } from "./accountNotices.js";
import { metadataRetryLoop } from "./metadataRetry.js";
import { rewardsComputeLoop } from "./rewardsCompute.js";
import { walletActivityRefreshLoop } from "./walletActivityRefresh.js";
import { runEvery, type Loop } from "./schedule.js";
import { recoverStuckFetchingTokens, recoverPendingWork } from "./startupRecovery.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator");

export const loops: Loop[] = [
  reaperLoop,
  unverifiedAccountsLoop,
  accountNoticesLoop,
  metadataRetryLoop,
  rewardsComputeLoop,
  walletActivityRefreshLoop,
];

export async function startOrchestrator(): Promise<void> {
  log.info("Orchestrator starting...");

  await recoverStuckFetchingTokens();

  await recoverPendingWork();

  for (const loop of loops) {
    runEvery(loop).catch((err) => log.error({ err, loop: loop.name }, "Loop crashed"));
  }
}
