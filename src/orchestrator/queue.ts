import { type JobType } from "@prisma/client";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("queue");

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  options?: { processAfter?: Date; maxAttempts?: number }
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      type,
      payload: payload as any,
      processAfter: options?.processAfter ?? new Date(),
      ...(options?.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    },
  });
  log.debug({ jobId: job.id, type }, "Job enqueued");
  return job.id;
}

export async function claimJob(): Promise<{
  id: string;
  type: JobType;
  payload: unknown;
  attempts: number;
} | null> {
  // Single round-trip: find a PENDING job and atomically flip it to PROCESSING.
  // updateMany doesn't return records, so we do findFirst → updateMany with
  // the same id+status filter, then verify the count to detect a lost race.
  const candidate = await prisma.job.findFirst({
    where: {
      status: "PENDING",
      processAfter: { lte: new Date() },
    },
    orderBy: { processAfter: "asc" },
  });

  if (!candidate) return null;

  if (candidate.attempts >= candidate.maxAttempts) {
    await prisma.job.update({
      where: { id: candidate.id },
      data: { status: "FAILED", error: "Max attempts exceeded" },
    });
    return null;
  }

  // Conditional update: only succeeds if this worker wins the race
  const { count } = await prisma.job.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });

  if (count === 0) return null; // another worker claimed it first

  return {
    id: candidate.id,
    type: candidate.type,
    payload: candidate.payload,
    attempts: candidate.attempts + 1,
  };
}

export async function completeJob(jobId: string): Promise<void> {
  await prisma.job.update({ where: { id: jobId }, data: { status: "DONE" } });
}

export async function failJob(
  jobId: string,
  error: string,
  retryAfterMs = 5000
): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;

  const shouldRetry = job.attempts < job.maxAttempts;
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: shouldRetry ? "PENDING" : "FAILED",
      error,
      processAfter: shouldRetry
        ? new Date(Date.now() + retryAfterMs * job.attempts)
        : undefined,
    },
  });
}
