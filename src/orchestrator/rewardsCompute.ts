import { computeRewards, type ComputeSummary } from "../rewards/compute.js";
import { createLogger } from "../utils/logger.js";
import type { Loop } from "./schedule.js";

const log = createLogger("orchestrator:rewards-compute");

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

async function recompute(): Promise<void> {
  const result = await runComputeGuarded(false);
  if ("skipped" in result) log.warn("Rewards compute already in flight — skipped tick");
  else log.info({ addresses: result.addresses, events: result.events }, "Rewards recomputed");
}

export const rewardsComputeLoop: Loop = {
  name: "rewards-compute",
  intervalMs: INTERVAL_MS,
  bootDelayMs: BOOT_DELAY_MS,
  tick: recompute,
};
