import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedTransfer } from "../../types/marketplace.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:transfer");

export async function handleTransfer(
  event: ParsedTransfer,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, tokenId, from, to, blockNumber, txHash, logIndex } = event;

  if (from === ZERO_ADDRESS) {
    // Mint: create token record
    await tx.token.upsert({
      where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
      create: { chain, contractAddress, tokenId, owner: to, metadataStatus: "PENDING" },
      update: { owner: to },
    });

    await tx.collection.upsert({
      where: { chain_contractAddress: { chain, contractAddress } },
      create: { chain, contractAddress, startBlock: blockNumber, isKnown: false },
      update: {},
    });
  } else {
    await tx.token.updateMany({
      where: { chain, contractAddress, tokenId },
      data: { owner: to },
    });
  }

  try {
    await tx.transfer.create({
      data: { chain, contractAddress, tokenId, fromAddress: from, toAddress: to, blockNumber, txHash, logIndex },
    });
  } catch (err: any) {
    if (err.code !== "P2002") throw err; // ignore unique constraint — already processed
  }

  log.debug({ chain, contractAddress, tokenId, from, to }, "Transfer processed");
}
