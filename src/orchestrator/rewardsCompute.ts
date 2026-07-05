import { computeRewards, type ComputeSummary } from "../rewards/compute.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:rewards-compute");
const INTERVAL_MS = Number(process.env.REWARDS_COMPUTE_INTERVAL_MS ?? 900_000); // 15 min

let running = false;

/** Single-flight guard shared by the loop and the admin endpoint. */
export async function runComputeGuarded(dryRun = false): Promise<ComputeSummary | { skipped: true }> {
  if (running) return { skipped: true };
  running = true;
  try {
    return await computeRewards({ dryRun });
  } finally {
    running = false;
  }
}

export async function startRewardsComputeLoop(): Promise<void> {
  log.info({ intervalMs: INTERVAL_MS }, "Rewards compute loop starting...");
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    try {
      const result = await runComputeGuarded(false);
      if ("skipped" in result) log.warn("Rewards compute already in flight — skipped tick");
      else log.info({ addresses: result.addresses, events: result.events }, "Rewards recomputed");
    } catch (err) {
      log.error({ err }, "Rewards compute loop error"); // previous scores remain
    }
  }
}
