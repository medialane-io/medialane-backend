import prisma from "../db/client.js";
import { worker } from "./worker.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:startup-recovery");

const CHAIN = "STARKNET" as const;

export async function recoverStuckFetchingTokens(): Promise<void> {
  const result = await prisma.token.updateMany({
    where: { metadataStatus: "FETCHING" },
    data: { metadataStatus: "PENDING" },
  });

  if (result.count > 0) {
    log.warn({ count: result.count }, "Reset stuck FETCHING tokens → PENDING on startup");
  }
}

export async function recoverPendingWork(): Promise<void> {
  const [pendingTokens, unnamedCollections] = await Promise.all([
    prisma.token.findMany({
      where: { metadataStatus: "PENDING" },
      select: { contractAddress: true, tokenId: true },
    }),
    prisma.collection.findMany({
      where: { OR: [{ name: null }, { name: "" }] },
      select: { contractAddress: true },
    }),
  ]);

  for (const token of pendingTokens) {
    worker.enqueue({ type: "METADATA_FETCH", chain: CHAIN, contractAddress: token.contractAddress, tokenId: token.tokenId });
  }

  for (const col of unnamedCollections) {
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: CHAIN, contractAddress: col.contractAddress });
  }

  if (pendingTokens.length > 0 || unnamedCollections.length > 0) {
    log.info(
      { pendingTokens: pendingTokens.length, unnamedCollections: unnamedCollections.length },
      "Re-enqueued pending work on startup"
    );
  }
}
