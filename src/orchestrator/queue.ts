import type { Chain } from "@prisma/client";
import { worker, type WorkItem } from "./worker.js";

/**
 * Enqueue background work for the in-process worker (metadata fetch, stats, etc.).
 * Used by one-shot scripts and mirror handlers.
 */
export function enqueueJob(
  type: "METADATA_FETCH",
  payload: { chain: Chain; contractAddress: string; tokenId: string }
): void;
export function enqueueJob(
  type: "STATS_UPDATE",
  payload: { chain: Chain; contractAddress: string }
): void;
export function enqueueJob(
  type: "COLLECTION_METADATA_FETCH",
  payload: { chain: Chain; contractAddress: string }
): void;
export function enqueueJob(type: WorkItem["type"], payload: Record<string, unknown>): void {
  worker.enqueue({ type, ...payload } as WorkItem);
}
