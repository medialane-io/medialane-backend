import { computeRewards, type ComputeSummary } from "../rewards/compute.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:rewards-compute");

// Rewards is a full-history recompute (see rewards/compute.ts), so its cost
// scales with total platform data, not with how often it runs. Badges and XP
// don't need per-day freshness, so it runs weekly rather than daily.
export const REWARDS_COMPUTE_INTERVAL_MS = Number(process.env.REWARDS_COMPUTE_INTERVAL_MS ?? 7 * 24 * 60 * 60 * 1000);
const INTERVAL_MS = REWARDS_COMPUTE_INTERVAL_MS;

const BOOT_DELAY_MS = 120_000;

let running = false;

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
  let nextDelay = BOOT_DELAY_MS;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, nextDelay));
    nextDelay = INTERVAL_MS;
    try {
      const result = await runComputeGuarded(false);
      if ("skipped" in result) log.warn("Rewards compute already in flight — skipped tick");
      else log.info({ addresses: result.addresses, events: result.events }, "Rewards recomputed");
    } catch (err) {
      log.error({ err }, "Rewards compute loop error");
    }
  }
}
