import type { Chain } from "@prisma/client";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ingestor");

/**
 * The per-chain event-ingestion seam (platform-federation spec §3.2). Each
 * supported chain contributes one ingestor that reduces its Medialane
 * contracts' events into the shared handlers — never bulk-indexing foreign
 * contracts. Starknet's ingestor wraps the existing mirror loops unchanged;
 * EVM/Solana/Stellar ingestors (Phases C–E) plug in here, gated on their
 * chain's coordinates being populated at deploy time.
 */
export interface ChainIngestor {
  chain: Chain;
  /** Starts the ingestor's polling loop(s). Must be idempotent per process. */
  start(): void;
}

export function registerIngestors(ingestors: ChainIngestor[]): void {
  for (const ingestor of ingestors) {
    log.info({ chain: ingestor.chain }, "starting chain ingestor");
    ingestor.start();
  }
}
