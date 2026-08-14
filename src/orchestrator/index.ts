import { startReaper } from "./reaper.js";
import { startWebhookDeliveryLoop } from "./webhook.js";
import { startMetadataRetryLoop } from "./metadataRetry.js";
import { startRewardsComputeLoop } from "./rewardsCompute.js";
import { startWalletActivityRefreshLoop } from "./walletActivityRefresh.js";
import { recoverStuckFetchingTokens, recoverPendingWork } from "./startupRecovery.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator");

export async function startOrchestrator(): Promise<void> {
  log.info("Orchestrator starting...");

  await recoverStuckFetchingTokens();

  await recoverPendingWork();

  startReaper().catch((err) => log.error({ err }, "Reaper crashed"));
  startWebhookDeliveryLoop().catch((err) => log.error({ err }, "Webhook delivery loop crashed"));
  startMetadataRetryLoop().catch((err) => log.error({ err }, "Metadata retry loop crashed"));
  startRewardsComputeLoop().catch((err) => log.error({ err }, "Rewards compute loop crashed"));
  startWalletActivityRefreshLoop().catch((err) => log.error({ err }, "Wallet-activity refresh loop crashed"));
}
