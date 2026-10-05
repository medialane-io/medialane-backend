import { createLogger } from "../utils/logger.js";
import { productionSweepDeps } from "../notices/prismaDeps.js";
import { needsAttention, sweepReminders, sweepWelcomes } from "../notices/sweep.js";

const log = createLogger("orchestrator:account-notices");

const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;

export async function startAccountNoticesLoop(): Promise<void> {
  log.info({ everyMinutes: SWEEP_INTERVAL_MS / 60_000 }, "Account notices started");

  for (;;) {
    try {
      const deps = productionSweepDeps();
      const reminders = await sweepReminders(deps);
      const welcomes = await sweepWelcomes(deps);
      if (reminders.due + welcomes.due > 0) log.info({ reminders, welcomes }, "Account notices sweep");
      if (needsAttention(reminders) || needsAttention(welcomes)) {
        log.warn({ reminders, welcomes }, "Account notices were due but not all were sent");
      }
    } catch (err) {
      log.error({ err }, "Account notices sweep failed");
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
  }
}
