import { type Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { worker } from "./worker.js";
import { handleStatsUpdate } from "./stats.js";
import { normalizeAddress } from "../utils/starknet.js";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../types/marketplace.js";

type NftTransferEvent = ParsedTransfer | ParsedTransferSingle | ParsedTransferBatch;

export interface TransferFollowupResult {
  contracts: string[];
  metadataJobs: number;
  collectionMetadataJobs: number;
  statsUpdated: number;
}

export async function runTransferFollowups(
  events: NftTransferEvent[],
  chain: Chain
): Promise<TransferFollowupResult> {
  const contracts = Array.from(new Set(events.map((event) => normalizeAddress(event.contractAddress))));
  if (contracts.length === 0) {
    return { contracts: [], metadataJobs: 0, collectionMetadataJobs: 0, statsUpdated: 0 };
  }

  const pendingTokens = await prisma.token.findMany({
    where: {
      chain,
      contractAddress: { in: contracts },
      metadataStatus: { in: ["PENDING", "FAILED"] },
    },
    select: { contractAddress: true, tokenId: true },
    take: 200,
  });

  for (const token of pendingTokens) {
    worker.enqueue({
      type: "METADATA_FETCH",
      chain,
      contractAddress: token.contractAddress,
      tokenId: token.tokenId,
    });
  }

  const pendingCollections = await prisma.collection.findMany({
    where: {
      chain,
      contractAddress: { in: contracts },
      OR: [
        { metadataStatus: { in: ["PENDING", "FAILED"] } },
        { name: null },
        { owner: null },
      ],
    },
    select: { contractAddress: true },
  });

  for (const collection of pendingCollections) {
    worker.enqueue({
      type: "COLLECTION_METADATA_FETCH",
      chain,
      contractAddress: collection.contractAddress,
    });
  }

  for (const contractAddress of contracts) {
    await handleStatsUpdate({ chain, contractAddress });
  }

  return {
    contracts,
    metadataJobs: pendingTokens.length,
    collectionMetadataJobs: pendingCollections.length,
    statsUpdated: contracts.length,
  };
}
