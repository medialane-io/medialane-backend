import { type Prisma } from "@prisma/client";
import type { ParsedTransfer } from "../../types/marketplace.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:transfer");

export async function handleTransfer(
  event: ParsedTransfer,
  tx: Prisma.TransactionClient
): Promise<void> {
  const { contractAddress, tokenId, from, to, blockNumber, txHash, logIndex } = event;

  if (from === ZERO_ADDRESS) {
    // Mint: create token record
    await tx.token.upsert({
      where: { contractAddress_tokenId: { contractAddress, tokenId } },
      create: { contractAddress, tokenId, owner: to, metadataStatus: "PENDING" },
      update: { owner: to },
    });

    await tx.collection.upsert({
      where: { contractAddress },
      create: { contractAddress, startBlock: blockNumber, isKnown: false },
      update: {},
    });
  } else {
    await tx.token.updateMany({
      where: { contractAddress, tokenId },
      data: { owner: to },
    });
  }

  try {
    await tx.transfer.create({
      data: { contractAddress, tokenId, fromAddress: from, toAddress: to, blockNumber, txHash, logIndex },
    });
  } catch (err: any) {
    if (err.code !== "P2002") throw err; // ignore unique constraint — already processed
  }

  log.debug({ contractAddress, tokenId, from, to }, "Transfer processed");
}
