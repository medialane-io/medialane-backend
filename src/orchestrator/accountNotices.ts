import { createLogger } from "../utils/logger.js";
import { productionSweepDeps } from "../notices/prismaDeps.js";
import { needsAttention, sweepReminders } from "../notices/sweep.js";

const log = createLogger("orchestrator:account-notices");

const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;

export async function startAccountNoticesLoop(): Promise<void> {
  log.info({ everyMinutes: SWEEP_INTERVAL_MS / 60_000 }, "Account notices started");

  for (;;) {
    try {
      const deps = productionSweepDeps();
      const reminders = await sweepReminders(deps);
      if (reminders.due > 0) log.info({ reminders }, "Account notices sweep");
      if (needsAttention(reminders)) {
        log.warn({ reminders }, "Account notices were due but not all were sent");
      }
    } catch (err) {
      log.error({ err }, "Account notices sweep failed");
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
  }
}
