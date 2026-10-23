import prisma from "../db/client.js";
import { worker, type WorkItem } from "./worker.js";
import { createLogger } from "../utils/logger.js";
import type { Loop } from "./schedule.js";

const log = createLogger("orchestrator:metadata-retry");

const RETRY_INTERVAL_MS = 2 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

type Page<R> = (args: { take: number; cursor?: { id: string }; skip?: number }) => Promise<R[]>;

interface RetryDeps {
  token: { findMany: (args: object) => Promise<{ id: string; chain: WorkItem["chain"]; contractAddress: string; tokenId: string }[]> };
  collection: { findMany: (args: object) => Promise<{ id: string; chain: WorkItem["chain"]; contractAddress: string }[]> };
  enqueue: (item: WorkItem) => void;
}

const defaultDeps: RetryDeps = {
  token: prisma.token as never,
  collection: prisma.collection as never,
  enqueue: (item) => worker.enqueue(item),
};

async function forEachPage<R extends { id: string }>(page: Page<R>, handle: (row: R) => void): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  while (true) {
    const rows = await page({ take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    rows.forEach(handle);
    count += rows.length;
    if (rows.length < BATCH_SIZE) return count;
    cursor = rows[rows.length - 1]!.id;
  }
}

export async function retryFailedMetadata(deps: RetryDeps = defaultDeps): Promise<{ tokens: number; collections: number }> {
  const tokens = await forEachPage(
    (page) =>
      deps.token.findMany({
        where: { metadataStatus: { in: ["PENDING", "FAILED"] } },
        select: { id: true, chain: true, contractAddress: true, tokenId: true },
        orderBy: { id: "asc" },
        ...page,
      }),
    (t) => deps.enqueue({ type: "METADATA_FETCH", chain: t.chain, contractAddress: t.contractAddress, tokenId: t.tokenId }),
  );
  const collections = await forEachPage(
    (page) =>
      deps.collection.findMany({
        where: { metadataStatus: "FAILED" },
        select: { id: true, chain: true, contractAddress: true },
        orderBy: { id: "asc" },
        ...page,
      }),
    (c) => deps.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: c.chain, contractAddress: c.contractAddress }),
  );
  if (tokens + collections > 0) log.info({ tokens, collections }, "Re-enqueued failed metadata fetches");
  return { tokens, collections };
}

export const metadataRetryLoop: Loop = {
  name: "metadata-retry",
  intervalMs: RETRY_INTERVAL_MS,
  tick: () => retryFailedMetadata(),
};
