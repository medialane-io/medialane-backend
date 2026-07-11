import { computeRewards, type ComputeSummary } from "../rewards/compute.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:rewards-compute");
// Rewards recompute is a full-history truncate-rebuild (~30 table scans) —
// daily by default (P-3, 2026-07-10 audit; was 15 min, which paid the full
// cost 96×/day for no product need — the platform messages "rewards
// recalculated daily"). On-demand: POST /admin/rewards/compute.
const INTERVAL_MS = Number(process.env.REWARDS_COMPUTE_INTERVAL_MS ?? 86_400_000); // 24 h
// First compute shortly after boot so a deploy refreshes scores without
// waiting a full interval (startup recovery gets a head start first).
const BOOT_DELAY_MS = 120_000;

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
  let nextDelay = BOOT_DELAY_MS;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, nextDelay));
    nextDelay = INTERVAL_MS;
    try {
      const result = await runComputeGuarded(false);
      if ("skipped" in result) log.warn("Rewards compute already in flight — skipped tick");
      else log.info({ addresses: result.addresses, events: result.events }, "Rewards recomputed");
    } catch (err) {
      log.error({ err }, "Rewards compute loop error"); // previous scores remain
    }
  }
}
