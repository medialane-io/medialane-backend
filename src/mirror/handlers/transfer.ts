import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedTransfer, ParsedTransferSingle, ParsedTransferBatch } from "../../types/marketplace.js";
export type { ParsedTransfer, ParsedTransferSingle, ParsedTransferBatch };
import { ZERO_ADDRESS } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:transfer");

// ---------------------------------------------------------------------------
// Balance helpers
// ---------------------------------------------------------------------------

async function incrementBalance(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  owner: string,
  amount: bigint
): Promise<void> {
  const existing = await tx.tokenBalance.findUnique({
    where: { chain_contractAddress_tokenId_owner: { chain, contractAddress, tokenId, owner } },
    select: { amount: true },
  });
  const newAmount = BigInt(existing?.amount ?? "0") + amount;
  await tx.tokenBalance.upsert({
    where: { chain_contractAddress_tokenId_owner: { chain, contractAddress, tokenId, owner } },
    create: { chain, contractAddress, tokenId, owner, amount: newAmount.toString() },
    update: { amount: newAmount.toString() },
  });
}

async function decrementBalance(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  owner: string,
  amount: bigint
): Promise<void> {
  if (owner === ZERO_ADDRESS) return; // mints have no sender balance to decrement
  const existing = await tx.tokenBalance.findUnique({
    where: { chain_contractAddress_tokenId_owner: { chain, contractAddress, tokenId, owner } },
    select: { amount: true },
  });
  const current = BigInt(existing?.amount ?? "0");
  const newAmount = current > amount ? current - amount : 0n;
  await tx.tokenBalance.upsert({
    where: { chain_contractAddress_tokenId_owner: { chain, contractAddress, tokenId, owner } },
    create: { chain, contractAddress, tokenId, owner, amount: "0" },
    update: { amount: newAmount.toString() },
  });
}

async function upsertTokenAndCollection(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  blockNumber: bigint
): Promise<void> {
  await tx.token.upsert({
    where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
    create: { chain, contractAddress, tokenId, metadataStatus: "PENDING" },
    update: {},
  });
  await tx.collection.upsert({
    where: { chain_contractAddress: { chain, contractAddress } },
    create: { chain, contractAddress, startBlock: blockNumber, isKnown: false, metadataStatus: "PENDING" },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// ERC-721 Transfer
// ---------------------------------------------------------------------------

export async function handleTransfer(
  event: ParsedTransfer,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, tokenId, from, to, blockNumber, txHash, logIndex } = event;

  await upsertTokenAndCollection(tx, chain, contractAddress, tokenId, blockNumber);

  // Update TokenBalance: ERC-721 is always quantity 1
  await decrementBalance(tx, chain, contractAddress, tokenId, from, 1n);
  await incrementBalance(tx, chain, contractAddress, tokenId, to, 1n);

  try {
    await tx.transfer.create({
      data: { chain, contractAddress, tokenId, fromAddress: from, toAddress: to, amount: "1", blockNumber, txHash, logIndex },
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }

  log.debug({ chain, contractAddress, tokenId, from, to }, "ERC-721 Transfer processed");
}

// ---------------------------------------------------------------------------
// ERC-1155 TransferSingle
// ---------------------------------------------------------------------------

export async function handleTransferSingle(
  event: ParsedTransferSingle,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, tokenId, from, to, amount, blockNumber, txHash, logIndex } = event;
  const qty = BigInt(amount);

  await upsertTokenAndCollection(tx, chain, contractAddress, tokenId, blockNumber);

  await decrementBalance(tx, chain, contractAddress, tokenId, from, qty);
  await incrementBalance(tx, chain, contractAddress, tokenId, to, qty);

  try {
    await tx.transfer.create({
      data: { chain, contractAddress, tokenId, fromAddress: from, toAddress: to, amount, blockNumber, txHash, logIndex },
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }

  log.debug({ chain, contractAddress, tokenId, from, to, amount }, "ERC-1155 TransferSingle processed");
}

// ---------------------------------------------------------------------------
// ERC-1155 TransferBatch
// ---------------------------------------------------------------------------

export async function handleTransferBatch(
  event: ParsedTransferBatch,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, from, to, transfers, blockNumber, txHash, logIndex } = event;

  for (let i = 0; i < transfers.length; i++) {
    const { tokenId, amount } = transfers[i];
    const qty = BigInt(amount);
    // Use a derived logIndex to keep the unique constraint stable across batch items
    const itemLogIndex = logIndex * 10000 + i;

    await upsertTokenAndCollection(tx, chain, contractAddress, tokenId, blockNumber);

    await decrementBalance(tx, chain, contractAddress, tokenId, from, qty);
    await incrementBalance(tx, chain, contractAddress, tokenId, to, qty);

    try {
      await tx.transfer.create({
        data: { chain, contractAddress, tokenId, fromAddress: from, toAddress: to, amount, blockNumber, txHash, logIndex: itemLogIndex },
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }

  log.debug({ chain, contractAddress, from, to, count: transfers.length }, "ERC-1155 TransferBatch processed");
}

// ---------------------------------------------------------------------------
// Unified dispatcher — routes Transfer / TransferSingle / TransferBatch
// ---------------------------------------------------------------------------

export async function dispatchTransfer(
  event: ParsedTransfer | ParsedTransferSingle | ParsedTransferBatch,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  if (event.type === "Transfer") return handleTransfer(event, tx, chain);
  if (event.type === "TransferSingle") return handleTransferSingle(event, tx, chain);
  if (event.type === "TransferBatch") return handleTransferBatch(event, tx, chain);
}
