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

  // Bind jobId + type once; all log calls within this job carry the correlation fields
  const jlog = log.child({ jobId: job.id, type: job.type });
  jlog.debug("Processing job");

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
        jlog.warn("Unknown job type");
    }
    await completeJob(job.id);
    jlog.debug("Job complete");
  } catch (err: any) {
    jlog.error({ err }, "Job failed");
    await failJob(job.id, err.message ?? "Unknown error");
  }
}
