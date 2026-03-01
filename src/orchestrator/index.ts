import { claimJob, completeJob, failJob } from "./queue.js";
import { handleMetadataFetch } from "./metadata.js";
import { handleMetadataPin } from "./metadataPin.js";
import { handleStatsUpdate } from "./stats.js";
import { handleWebhookDeliver } from "./webhook.js";
import { sleep } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator");
const POLL_INTERVAL_MS = 2000;

export async function startOrchestrator(): Promise<void> {
  log.info("Orchestrator starting...");

  while (true) {
    try {
      await processNextJob();
    } catch (err) {
      log.error({ err }, "Orchestrator error");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob(): Promise<void> {
  const job = await claimJob();
  if (!job) return;

  log.debug({ jobId: job.id, type: job.type }, "Processing job");

  try {
    switch (job.type) {
      case "METADATA_FETCH":
        await handleMetadataFetch(job.payload as { chain: string; contractAddress: string; tokenId: string });
        break;
      case "METADATA_PIN":
        await handleMetadataPin(job.payload as { cid: string });
        break;
      case "STATS_UPDATE":
        await handleStatsUpdate(job.payload as { chain: string; contractAddress: string });
        break;
      case "WEBHOOK_DELIVER":
        await handleWebhookDeliver(job.payload as { deliveryId: string });
        break;
      default:
        log.warn({ type: job.type }, "Unknown job type");
    }
    await completeJob(job.id);
    log.debug({ jobId: job.id, type: job.type }, "Job complete");
  } catch (err: any) {
    log.error({ err, jobId: job.id, type: job.type }, "Job failed");
    await failJob(job.id, err.message ?? "Unknown error");
  }
}
