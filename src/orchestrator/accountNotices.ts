import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { productionSweepDeps } from "../notices/prismaDeps.js";
import { sweepReminders } from "../notices/sweep.js";

const log = createLogger("orchestrator:account-notices");

const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;

export async function startAccountNoticesLoop(): Promise<void> {
  if (!env.IO_CLIENT_ID) {
    log.warn("Account notices need IO_CLIENT_ID; not starting");
    return;
  }

  for (;;) {
    try {
      const result = await sweepReminders(productionSweepDeps());
      if (result.due > 0 || result.released > 0) log.info(result, "Account notices sweep");
    } catch (err) {
      log.error({ err }, "Account notices sweep failed");
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
  }
}
