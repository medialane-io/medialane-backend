#!/usr/bin/env bun
/**
 * One-shot script to fix ERC-1155 balance double-counting.
 *
 * Root cause: some ERC-1155 contracts emit both Transfer (ERC-721 compat) and
 * TransferSingle for the same operation. The indexer previously recorded both,
 * causing each buyer's balance to be incremented twice.
 *
 * This script:
 *  1. Finds duplicate Transfer rows — same (chain, txHash, contractAddress, tokenId,
 *     fromAddress, toAddress) but different logIndex.
 *  2. Deletes the extra rows (keeps the lowest logIndex).
 *  3. Corrects TokenBalance for each affected (owner, token) pair by re-computing
 *     the balance from the surviving Transfer rows.
 *
 * Safe to run multiple times (idempotent).
 *
 * Usage: bun run scripts/fix-erc1155-double-balance.ts [--dry-run]
 */

import prisma from "../src/db/client.js";
import { createLogger } from "../src/utils/logger.js";

const log = createLogger("fix-erc1155-double-balance");
const DRY_RUN = process.argv.includes("--dry-run");

if (DRY_RUN) log.info("DRY RUN — no writes will be made");

type Chain = "STARKNET";
const CHAIN: Chain = "STARKNET";

async function main() {
  // Step 1: Find all (txHash, contractAddress, tokenId, fromAddress, toAddress) groups
  // with more than one Transfer row — these are the duplicates.
  log.info("Scanning for duplicate Transfer rows...");

  const duplicates = await prisma.$queryRaw<Array<{
    txHash: string;
    contractAddress: string;
    tokenId: string;
    fromAddress: string;
    toAddress: string;
    count: bigint;
  }>>`
    SELECT
      "txHash",
      "contractAddress",
      "tokenId",
      "fromAddress",
      "toAddress",
      COUNT(*) as count
    FROM "Transfer"
    WHERE chain = 'STARKNET'
    GROUP BY "txHash", "contractAddress", "tokenId", "fromAddress", "toAddress"
    HAVING COUNT(*) > 1
  `;

  log.info({ duplicateGroups: duplicates.length }, "Found duplicate groups");

  if (duplicates.length === 0) {
    log.info("No duplicates found — balances are correct.");
    return;
  }

  // Affected (contractAddress, tokenId, address) combos — we'll recompute these balances.
  const affectedBalances = new Set<string>(); // key: "contractAddress:tokenId:owner"

  let totalDeleted = 0;

  for (const dup of duplicates) {
    const { txHash, contractAddress, tokenId, fromAddress, toAddress } = dup;
    const extraCount = Number(dup.count) - 1; // how many rows to remove

    // Find all rows for this group, ordered by logIndex asc — keep the first.
    const rows = await prisma.transfer.findMany({
      where: { chain: CHAIN, txHash, contractAddress, tokenId, fromAddress, toAddress },
      orderBy: { logIndex: "asc" },
      select: { id: true, logIndex: true, amount: true },
    });

    // Keep the first (lowest logIndex), delete the rest.
    const toDelete = rows.slice(1);

    log.info(
      { txHash: txHash.slice(0, 12), contractAddress: contractAddress.slice(0, 12), tokenId, extraCount },
      "Removing extra Transfer rows"
    );

    if (!DRY_RUN) {
      await prisma.transfer.deleteMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
      });
    }

    totalDeleted += toDelete.length;

    // Mark both sender and receiver for balance recompute.
    if (fromAddress !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      affectedBalances.add(`${contractAddress}:${tokenId}:${fromAddress}`);
    }
    affectedBalances.add(`${contractAddress}:${tokenId}:${toAddress}`);
  }

  log.info({ totalDeleted }, "Removed duplicate Transfer rows");

  // Step 2: Recompute TokenBalance for each affected (contractAddress, tokenId, owner).
  // Balance = SUM(amount where toAddress=owner) - SUM(amount where fromAddress=owner)
  log.info({ affectedCount: affectedBalances.size }, "Recomputing balances...");

  let corrected = 0;
  let unchanged = 0;

  for (const key of affectedBalances) {
    const [contractAddress, tokenId, owner] = key.split(":");

    const inboundRows = await prisma.transfer.findMany({
      where: { chain: CHAIN, contractAddress, tokenId, toAddress: owner },
      select: { amount: true },
    });
    const outboundRows = await prisma.transfer.findMany({
      where: { chain: CHAIN, contractAddress, tokenId, fromAddress: owner },
      select: { amount: true },
    });

    const inboundTotal = inboundRows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
    const outboundTotal = outboundRows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
    const correctBalance = inboundTotal - outboundTotal;

    // Read current balance
    const current = await prisma.tokenBalance.findUnique({
      where: { chain_contractAddress_tokenId_owner: { chain: CHAIN, contractAddress, tokenId, owner } },
      select: { amount: true },
    });

    const currentAmount = current ? BigInt(current.amount) : 0n;

    if (currentAmount === correctBalance) {
      unchanged++;
      continue;
    }

    log.info(
      {
        contractAddress: contractAddress.slice(0, 12),
        tokenId,
        owner: owner.slice(0, 12),
        current: currentAmount.toString(),
        correct: correctBalance.toString(),
      },
      "Correcting balance"
    );

    if (!DRY_RUN) {
      if (correctBalance <= 0n) {
        // Remove zero or negative balance records
        await prisma.tokenBalance.upsert({
          where: { chain_contractAddress_tokenId_owner: { chain: CHAIN, contractAddress, tokenId, owner } },
          create: { chain: CHAIN, contractAddress, tokenId, owner, amount: "0" },
          update: { amount: "0" },
        });
      } else {
        await prisma.tokenBalance.upsert({
          where: { chain_contractAddress_tokenId_owner: { chain: CHAIN, contractAddress, tokenId, owner } },
          create: { chain: CHAIN, contractAddress, tokenId, owner, amount: correctBalance.toString() },
          update: { amount: correctBalance.toString() },
        });
      }
    }

    corrected++;
  }

  log.info({ corrected, unchanged, DRY_RUN }, "Balance correction complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, "Script failed");
    process.exit(1);
  });
