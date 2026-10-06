import { type Chain } from "@prisma/client";
import { handleMetadataFetch } from "./metadata.js";
import { handleStatsUpdate } from "./stats.js";
import { handleCollectionMetadataFetch } from "./collectionMetadata.js";
import { syncWalletActivityProd } from "../walletActivity/sync.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("worker");

export type WorkItem =
  | { type: "METADATA_FETCH"; chain: Chain; contractAddress: string; tokenId: string }
  | { type: "STATS_UPDATE"; chain: Chain; contractAddress: string }
  | { type: "COLLECTION_METADATA_FETCH"; chain: Chain; contractAddress: string }
  | { type: "WALLET_ACTIVITY_SYNC"; chain: Chain; accountAddress: string };

interface QueuedItem {
  item: WorkItem;
  attempts: number;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5000;
const CONCURRENCY = 6;

class InMemoryWorker {
  private queue: QueuedItem[] = [];
  private pendingKeys = new Set<string>();
  private active = 0;
  private retrying = 0;

  private key(item: WorkItem): string {
    switch (item.type) {
      case "METADATA_FETCH":
        return `${item.type}:${item.chain}:${item.contractAddress}:${item.tokenId}`;
      case "STATS_UPDATE":
      case "COLLECTION_METADATA_FETCH":
        return `${item.type}:${item.chain}:${item.contractAddress}`;
      case "WALLET_ACTIVITY_SYNC":
        return `${item.type}:${item.chain}:${item.accountAddress}`;
    }
  }

  enqueue(item: WorkItem): void {
    const k = this.key(item);
    if (this.pendingKeys.has(k)) return;
    this.pendingKeys.add(k);
    this.queue.push({ item, attempts: 0 });
    this.pump();
  }

  private idle(): boolean {
    return this.active === 0 && this.retrying === 0 && this.queue.length === 0;
  }

  async waitDrain(timeoutMs: number): Promise<void> {
    if (this.idle()) return;
    return new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, timeoutMs);
      const poll = setInterval(() => {
        if (this.idle()) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 100);
    });
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.active++;
      void this.run(entry).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(entry: QueuedItem): Promise<void> {
    const k = this.key(entry.item);
    try {
      await this.process(entry.item);
      this.pendingKeys.delete(k);
    } catch (err) {
      entry.attempts++;
      if (entry.attempts < MAX_ATTEMPTS) {
        const delay = RETRY_BASE_MS * entry.attempts;
        log.warn({ type: entry.item.type, attempts: entry.attempts, delay }, "Worker: retrying after error");
        this.retrying++;
        setTimeout(() => {
          this.retrying--;
          this.queue.push(entry);
          this.pump();
        }, delay);
      } else {
        log.error({ err, type: entry.item.type, attempts: entry.attempts }, "Worker: item exhausted retries");
        this.pendingKeys.delete(k);
      }
    }
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
      case "WALLET_ACTIVITY_SYNC":
        await syncWalletActivityProd(item.chain, item.accountAddress);
        break;
    }
  }
}

export const worker = new InMemoryWorker();
