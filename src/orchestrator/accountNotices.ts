import { createLogger } from "../utils/logger.js";
import { productionSweepDeps } from "../notices/prismaDeps.js";
import { needsAttention, sweepReminders } from "../notices/sweep.js";
import type { Loop } from "./schedule.js";

const log = createLogger("orchestrator:account-notices");

const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;

async function sweep(): Promise<void> {
  const reminders = await sweepReminders(productionSweepDeps());
  if (reminders.due > 0) log.info({ reminders }, "Account notices sweep");
  if (needsAttention(reminders)) {
    log.warn({ reminders }, "Account notices were due but not all were sent");
  }
}

export const accountNoticesLoop: Loop = { name: "account-notices", intervalMs: SWEEP_INTERVAL_MS, tick: sweep };
