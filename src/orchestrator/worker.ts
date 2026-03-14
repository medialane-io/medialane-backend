import { type Chain } from "@prisma/client";
import { handleMetadataFetch } from "./metadata.js";
import { handleStatsUpdate } from "./stats.js";
import { handleCollectionMetadataFetch } from "./collectionMetadata.js";
import { createLogger } from "../utils/logger.js";
import { sleep } from "../utils/retry.js";

const log = createLogger("worker");

export type WorkItem =
  | { type: "METADATA_FETCH"; chain: Chain; contractAddress: string; tokenId: string }
  | { type: "STATS_UPDATE"; chain: Chain; contractAddress: string }
  | { type: "COLLECTION_METADATA_FETCH"; chain: Chain; contractAddress: string };

interface QueuedItem {
  item: WorkItem;
  attempts: number;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5000;

class InMemoryWorker {
  private queue: QueuedItem[] = [];
  private pendingKeys = new Set<string>();
  private running = false;

  private key(item: WorkItem): string {
    const base = `${item.type}:${item.chain}:${item.contractAddress}`;
    return item.type === "METADATA_FETCH" ? `${base}:${item.tokenId}` : base;
  }

  enqueue(item: WorkItem): void {
    const k = this.key(item);
    if (this.pendingKeys.has(k)) return;
    this.pendingKeys.add(k);
    this.queue.push({ item, attempts: 0 });
    if (!this.running) this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const k = this.key(entry.item);
      this.pendingKeys.delete(k);
      try {
        await this.process(entry.item);
      } catch (err) {
        entry.attempts++;
        if (entry.attempts < MAX_ATTEMPTS) {
          const delay = RETRY_BASE_MS * entry.attempts;
          log.warn({ type: entry.item.type, attempts: entry.attempts, delay }, "Worker: retrying after error");
          await sleep(delay);
          this.pendingKeys.add(k);
          this.queue.push(entry);
        } else {
          log.error({ err, type: entry.item.type, attempts: entry.attempts }, "Worker: item exhausted retries");
        }
      }
    }
    this.running = false;
  }

  private async process(item: WorkItem): Promise<void> {
    switch (item.type) {
      case "METADATA_FETCH":
        await handleMetadataFetch({ chain: item.chain, contractAddress: item.contractAddress, tokenId: item.tokenId });
        break;
      case "STATS_UPDATE":
        await handleStatsUpdate({ chain: item.chain, contractAddress: item.contractAddress });
        break;
      case "COLLECTION_METADATA_FETCH":
        await handleCollectionMetadataFetch({ chain: item.chain, contractAddress: item.contractAddress });
        break;
    }
  }
}

export const worker = new InMemoryWorker();
