import prisma from "../db/client.js";
import { worker } from "./worker.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:metadata-retry");

// Re-enqueue FAILED tokens every 6 hours. Batch size kept small to avoid
// overwhelming the queue on instances with many failed tokens.
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

export async function startMetadataRetryLoop(): Promise<void> {
  log.info("Metadata retry loop starting...");
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    try {
      const failed = await prisma.token.findMany({
        where: { metadataStatus: "FAILED" },
        select: { chain: true, contractAddress: true, tokenId: true },
        take: BATCH_SIZE,
        orderBy: { updatedAt: "asc" }, // oldest failures first
      });

      if (failed.length === 0) continue;

      log.info({ count: failed.length }, "Re-enqueueing failed metadata fetches");
      for (const token of failed) {
        worker.enqueue({ type: "METADATA_FETCH", chain: token.chain, contractAddress: token.contractAddress, tokenId: token.tokenId });
      }
    } catch (err) {
      log.error({ err }, "Metadata retry loop error");
    }
  }
}
