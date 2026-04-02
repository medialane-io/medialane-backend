import { startReaper } from "./reaper.js";
import { startWebhookDeliveryLoop } from "./webhook.js";
import { startMetadataRetryLoop } from "./metadataRetry.js";
import { recoverStuckFetchingTokens } from "./startupRecovery.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator");

export async function startOrchestrator(): Promise<void> {
  log.info("Orchestrator starting...");

  // Reset any tokens stuck in FETCHING from a previous crash before starting loops
  await recoverStuckFetchingTokens();

  startReaper().catch((err) => log.error({ err }, "Reaper crashed"));
  startWebhookDeliveryLoop().catch((err) => log.error({ err }, "Webhook delivery loop crashed"));
  startMetadataRetryLoop().catch((err) => log.error({ err }, "Metadata retry loop crashed"));
}
