import { type Chain, type Prisma, type TokenStandard } from "@prisma/client";
import type { ParsedTransfer, ParsedTransferSingle, ParsedTransferBatch } from "../../types/marketplace.js";
export type { ParsedTransfer, ParsedTransferSingle, ParsedTransferBatch };
import { ZERO_ADDRESS } from "../../config/constants.js";
import { ensureCollectionFromActivity } from "../../utils/collection.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:transfer");

async function incrementBalance(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  owner: string,
  amount: bigint
): Promise<void> {
  if (owner === ZERO_ADDRESS) return;
  await tx.$executeRaw`
    INSERT INTO "TokenBalance" (id, chain, "contractAddress", "tokenId", owner, amount, "updatedAt")
    VALUES (gen_random_uuid()::text, ${chain}::"Chain", ${contractAddress}, ${tokenId}, ${owner}, ${amount.toString()}, NOW())
    ON CONFLICT (chain, "contractAddress", "tokenId", owner)
    DO UPDATE SET amount = ("TokenBalance".amount::numeric + ${amount.toString()}::numeric)::text, "updatedAt" = NOW()
  `;
}

async function decrementBalance(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  owner: string,
  amount: bigint
): Promise<void> {
  if (owner === ZERO_ADDRESS) return;
  await tx.$executeRaw`
    INSERT INTO "TokenBalance" (id, chain, "contractAddress", "tokenId", owner, amount, "updatedAt")
    VALUES (gen_random_uuid()::text, ${chain}::"Chain", ${contractAddress}, ${tokenId}, ${owner}, '0', NOW())
    ON CONFLICT (chain, "contractAddress", "tokenId", owner)
    DO UPDATE SET amount = GREATEST("TokenBalance".amount::numeric - ${amount.toString()}::numeric, 0)::text, "updatedAt" = NOW()
  `;
}

async function upsertTokenAndCollection(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  blockNumber: bigint,
  standard: TokenStandard,
): Promise<void> {
  await tx.token.upsert({
    where: { chain_contractAddress_tokenId: { chain, contractAddress, tokenId } },
    create: { chain, contractAddress, tokenId, metadataStatus: "PENDING" },
    update: {},
  });
  await ensureCollectionFromActivity(tx, { chain, contractAddress, standard, blockNumber });
}

async function createTransferIfNew(
  tx: Prisma.TransactionClient,
  data: {
    chain: Chain;
    contractAddress: string;
    tokenId: string;
    fromAddress: string;
    toAddress: string;
    amount: string;
    blockNumber: bigint;
    txHash: string;
    logIndex: number;
  }
): Promise<boolean> {
  const existingTransfer = await tx.transfer.findFirst({
    where: {
      chain: data.chain,
      txHash: data.txHash,
      contractAddress: data.contractAddress,
      tokenId: data.tokenId,
      fromAddress: data.fromAddress,
      toAddress: data.toAddress,
      amount: data.amount,
    },
    select: { id: true },
  });
  if (existingTransfer) return false;

  try {
    await tx.transfer.create({ data });
    return true;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") return false;
    throw err;
  }
}

export async function handleTransfer(
  event: ParsedTransfer,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, tokenId, from, to, blockNumber, txHash, logIndex } = event;

  await upsertTokenAndCollection(tx, chain, contractAddress, tokenId, blockNumber, "ERC721");

  const isNew = await createTransferIfNew(tx, {
    chain,
    contractAddress,
    tokenId,
    fromAddress: from,
    toAddress: to,
    amount: "1",
    blockNumber,
    txHash,
    logIndex,
  });
  if (!isNew) return;

  await decrementBalance(tx, chain, contractAddress, tokenId, from, 1n);
  await incrementBalance(tx, chain, contractAddress, tokenId, to, 1n);

  log.debug({ chain, contractAddress, tokenId, from, to }, "ERC-721 Transfer processed");
}

export async function handleTransferSingle(
  event: ParsedTransferSingle,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, tokenId, from, to, amount, blockNumber, txHash, logIndex } = event;
  const qty = BigInt(amount);

  await upsertTokenAndCollection(tx, chain, contractAddress, tokenId, blockNumber, "ERC1155");

  const isNew = await createTransferIfNew(tx, {
    chain,
    contractAddress,
    tokenId,
    fromAddress: from,
    toAddress: to,
    amount,
    blockNumber,
    txHash,
    logIndex,
  });
  if (!isNew) return;

  await decrementBalance(tx, chain, contractAddress, tokenId, from, qty);
  await incrementBalance(tx, chain, contractAddress, tokenId, to, qty);

  log.debug({ chain, contractAddress, tokenId, from, to, amount }, "ERC-1155 TransferSingle processed");
}

export async function handleTransferBatch(
  event: ParsedTransferBatch,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const { contractAddress, from, to, transfers, blockNumber, txHash, logIndex } = event;

  for (let i = 0; i < transfers.length; i++) {
    const { tokenId, amount } = transfers[i];
    const qty = BigInt(amount);

    const itemLogIndex = logIndex * 10000 + i;

    await upsertTokenAndCollection(tx, chain, contractAddress, tokenId, blockNumber, "ERC1155");

    const isNew = await createTransferIfNew(tx, {
      chain,
      contractAddress,
      tokenId,
      fromAddress: from,
      toAddress: to,
      amount,
      blockNumber,
      txHash,
      logIndex: itemLogIndex,
    });
    if (!isNew) continue;

    await decrementBalance(tx, chain, contractAddress, tokenId, from, qty);
    await incrementBalance(tx, chain, contractAddress, tokenId, to, qty);
  }

  log.debug({ chain, contractAddress, from, to, count: transfers.length }, "ERC-1155 TransferBatch processed");
}

export async function dispatchTransfer(
  event: ParsedTransfer | ParsedTransferSingle | ParsedTransferBatch,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  if (event.type === "Transfer") return handleTransfer(event, tx, chain);
  if (event.type === "TransferSingle") return handleTransferSingle(event, tx, chain);
  if (event.type === "TransferBatch") return handleTransferBatch(event, tx, chain);
}
