import type { Chain } from "@prisma/client";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ingestor");

export interface ChainIngestor {
  chain: Chain;

  start(): void;
}

export function registerIngestors(ingestors: ChainIngestor[]): void {
  for (const ingestor of ingestors) {
    log.info({ chain: ingestor.chain }, "starting chain ingestor");
    ingestor.start();
  }
}
