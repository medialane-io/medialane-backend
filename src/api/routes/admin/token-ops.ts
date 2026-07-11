import { Hono } from "hono";
import { createLogger } from "../../../utils/logger.js";
import prisma from "../../../db/client.js";
import { handleMetadataFetch } from "../../../orchestrator/metadata.js";
import { handleStatsUpdate } from "../../../orchestrator/stats.js";
import { normalizeAddress, normalizeHash } from "../../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../../config/constants.js";
import { toErrorMessage } from "../../../utils/error.js";

const log = createLogger("routes:admin");

/**
 * Token-level admin ops (force metadata refresh, balance rebuild). Split out
 * of admin/collections.ts 2026-07-11 (registrar pattern, audit follow-up #8).
 */
export function registerTokenOpsRoutes(admin: Hono) {
// POST /admin/tokens/:contract/:tokenId/refresh — force sync metadata
// ---------------------------------------------------------------------------
admin.post("/tokens/:contract/:tokenId/refresh", async (c) => {
  const { contract, tokenId } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);

  // Guard: only refresh tokens from registered collections to prevent
  // arbitrary on-chain RPC calls for unregistered contracts.
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    select: { id: true },
  });
  if (!col) return c.json({ error: "Collection not registered" }, 404);

  try {
    await handleMetadataFetch({ chain: "STARKNET", contractAddress, tokenId });
    const token = await prisma.token.findUnique({
      where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress, tokenId } },
    });
    return c.json({ data: { metadataStatus: token?.metadataStatus, tokenUri: token?.tokenUri, name: token?.name } });
  } catch (err) {
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/tokens/:contract/:tokenId/rebuild-balances — replay indexed
// transfers for one token and replace TokenBalance with deterministic state.
// ---------------------------------------------------------------------------
admin.post("/tokens/:contract/:tokenId/rebuild-balances", async (c) => {
  const { contract, tokenId } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);

  const result = await prisma.$transaction(async (tx) => {
    const transfers = await tx.transfer.findMany({
      where: { chain: "STARKNET", contractAddress, tokenId },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
      select: {
        id: true,
        txHash: true,
        logIndex: true,
        contractAddress: true,
        tokenId: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        blockNumber: true,
      },
    });

    const uniqueTransfers = new Map<string, (typeof transfers)[number]>();
    const duplicateTransferIds: string[] = [];
    const txHashUpdates: Array<{ id: string; txHash: string }> = [];

    for (const transfer of transfers) {
      const normalizedTxHash = normalizeHash(transfer.txHash);
      const key = [
        normalizedTxHash,
        transfer.contractAddress,
        transfer.tokenId,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.amount,
      ].join(":");
      const existing = uniqueTransfers.get(key);

      if (!existing) {
        uniqueTransfers.set(key, transfer);
        if (transfer.txHash !== normalizedTxHash) {
          txHashUpdates.push({ id: transfer.id, txHash: normalizedTxHash });
        }
        continue;
      }

      const existingIsCanonical = existing.txHash === normalizedTxHash;
      const transferIsCanonical = transfer.txHash === normalizedTxHash;
      if (!existingIsCanonical && transferIsCanonical) {
        duplicateTransferIds.push(existing.id);
        uniqueTransfers.set(key, transfer);
      } else {
        duplicateTransferIds.push(transfer.id);
      }
    }

    if (duplicateTransferIds.length > 0) {
      await tx.transfer.deleteMany({ where: { id: { in: duplicateTransferIds } } });
    }

    for (const { id, txHash } of txHashUpdates) {
      if (!duplicateTransferIds.includes(id)) {
        await tx.transfer.update({ where: { id }, data: { txHash } });
      }
    }

    const balances = new Map<string, bigint>();
    const replayTransfers = [...uniqueTransfers.values()].sort((a, b) => {
      const blockDelta = a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0;
      return blockDelta || a.logIndex - b.logIndex;
    });

    for (const transfer of replayTransfers) {
      const amount = BigInt(transfer.amount);
      const from = transfer.fromAddress;
      const to = transfer.toAddress;

      if (from !== ZERO_ADDRESS) {
        const next = (balances.get(from) ?? 0n) - amount;
        balances.set(from, next > 0n ? next : 0n);
      }
      if (to !== ZERO_ADDRESS) {
        balances.set(to, (balances.get(to) ?? 0n) + amount);
      }
    }

    await tx.tokenBalance.deleteMany({
      where: { chain: "STARKNET", contractAddress, tokenId },
    });

    const rows = [...balances.entries()]
      .filter(([, amount]) => amount > 0n)
      .map(([owner, amount]) => ({
        chain: "STARKNET" as const,
        contractAddress,
        tokenId,
        owner,
        amount: amount.toString(),
      }));

    if (rows.length > 0) {
      await tx.tokenBalance.createMany({ data: rows });
    }

    return {
      transferCount: replayTransfers.length,
      duplicateTransferCount: duplicateTransferIds.length,
      normalizedTransferCount: txHashUpdates.length,
      balances: rows,
    };
  }, { timeout: 60000 });

  await handleStatsUpdate({ chain: "STARKNET", contractAddress });

  log.info({ contractAddress, tokenId, ...result }, "Token balances rebuilt from transfer ledger");
  return c.json({ data: { contractAddress, tokenId, ...result } });
});
}
