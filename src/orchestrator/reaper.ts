import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:reaper");

const MAX_REAPER_ATTEMPTS = 5;
const REAPER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const REAPER_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function runReaper(): Promise<void> {
  const cooldownThreshold = new Date(Date.now() - REAPER_COOLDOWN_MS);

  const failedJobs = await prisma.job.findMany({
    where: {
      status: "FAILED",
      reaperAttempts: { lt: MAX_REAPER_ATTEMPTS },
      updatedAt: { lte: cooldownThreshold },
    },
    take: 50,
  });

  if (failedJobs.length === 0) return;

  log.info({ count: failedJobs.length }, "Reaper: re-queuing failed jobs");

  for (const job of failedJobs) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "PENDING",
        attempts: 0,
        error: null,
        processAfter: new Date(),
        reaperAttempts: { increment: 1 },
      },
    });
    log.info({ jobId: job.id, type: job.type, reaperAttempts: job.reaperAttempts + 1 }, "Reaper: re-queued job");
  }
}

export async function startReaper(): Promise<void> {
  log.info("Reaper started");
  while (true) {
    try {
      await runReaper();
    } catch (err) {
      log.error({ err }, "Reaper error");
    }
    await new Promise((resolve) => setTimeout(resolve, REAPER_POLL_INTERVAL_MS));
  }
}
