import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:startup-recovery");

/**
 * Resets tokens stuck in FETCHING status back to PENDING.
 * This can happen when the process is killed mid-fetch, leaving tokens in an
 * intermediate state that the normal worker loop never re-processes.
 * Run once on startup before the worker loop begins.
 */
export async function recoverStuckFetchingTokens(): Promise<void> {
  const result = await prisma.token.updateMany({
    where: { metadataStatus: "FETCHING" },
    data: { metadataStatus: "PENDING" },
  });

  if (result.count > 0) {
    log.warn({ count: result.count }, "Reset stuck FETCHING tokens → PENDING on startup");
  }
}
