import { startReaper } from "./reaper.js";
import { startWebhookDeliveryLoop } from "./webhook.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator");

export async function startOrchestrator(): Promise<void> {
  log.info("Orchestrator starting...");
  startReaper().catch((err) => log.error({ err }, "Reaper crashed"));
  startWebhookDeliveryLoop().catch((err) => log.error({ err }, "Webhook delivery loop crashed"));
}
