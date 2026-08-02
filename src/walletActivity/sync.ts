import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { normalizeAddress } from "../utils/starknet.js";
import { pollContractEvents } from "../mirror/poller.js";
import { SUPPORTED_TOKENS, TRANSFER_SELECTOR, START_BLOCK } from "../config/constants.js";
import { decodeTransferLeg, decodeAccountEvent, pairSwapLegs, type TransferLeg } from "./decode.js";
import { mapWithConcurrency } from "../utils/retry.js";
import type { RawStarknetEvent } from "../types/starknet.js";

export interface SyncDeps {
  getCursor: (chain: Chain, accountAddress: string) => Promise<{ lastSyncedBlock: bigint } | null>;
  getLatestBlock: () => Promise<number>;
  pollEvents: (params: { address: string; fromBlock: number; toBlock: number; keys: string[][] }) => Promise<RawStarknetEvent[]>;
  getBlockTimestamp: (blockNumber: number) => Promise<Date>;
  upsertActivities: (rows: Array<Record<string, unknown>>) => Promise<void>;
  setCursor: (chain: Chain, accountAddress: string, block: bigint) => Promise<void>;
}

const TOKEN_POLL_CONCURRENCY = 4;
const BLOCK_TIMESTAMP_CONCURRENCY = 8;

export async function syncWalletActivity(deps: SyncDeps, chain: Chain, accountAddressRaw: string): Promise<void> {
  const accountAddress = normalizeAddress(chain, accountAddressRaw);
  const cursor = await deps.getCursor(chain, accountAddress);
  const fromBlock = cursor ? Number(cursor.lastSyncedBlock) + 1 : START_BLOCK;
  const toBlock = await deps.getLatestBlock();
  if (fromBlock > toBlock) return;

  // Two queries per token: one for legs OUT of the account (keys[1]=account),
  // one for legs IN to it (keys[1]=any via [], keys[2]=account) — Starknet's
  // getEvents keys filter is positional-OR-within-position, not OR-across-
  // positions, so "from OR to = account" needs two calls.
  const tokenEvents = (
    await mapWithConcurrency(SUPPORTED_TOKENS, TOKEN_POLL_CONCURRENCY, async (token) => {
      const [outLegs, inLegs] = await Promise.all([
        deps.pollEvents({ address: token.address, fromBlock, toBlock, keys: [[TRANSFER_SELECTOR], [accountAddress]] }),
        deps.pollEvents({ address: token.address, fromBlock, toBlock, keys: [[TRANSFER_SELECTOR], [], [accountAddress]] }),
      ]);
      return [...outLegs, ...inLegs].map((event) => ({ event, tokenAddress: token.address }));
    })
  ).flat();

  const accountEvents = await deps.pollEvents({ address: accountAddress, fromBlock, toBlock, keys: [] });

  const legs: TransferLeg[] = [];
  const seenTxType = new Set<string>();
  for (const { event, tokenAddress } of tokenEvents) {
    const leg = decodeTransferLeg(event, tokenAddress);
    if (!leg) continue;
    const dedupeKey = `${leg.txHash}:${tokenAddress}:${leg.from}:${leg.to}`;
    if (seenTxType.has(dedupeKey)) continue; // the two-query fan-out can return the same leg twice
    seenTxType.add(dedupeKey);
    legs.push(leg);
  }

  const { swaps, remaining } = pairSwapLegs(legs, accountAddress);

  const rows: Array<Record<string, unknown>> = [];
  for (const leg of remaining) {
    rows.push({
      chain, accountAddress, type: leg.from === accountAddress ? "SEND" : "RECEIVE",
      txHash: leg.txHash, blockNumber: leg.blockNumber,
      tokenAddress: leg.tokenAddress, amount: leg.amount,
      counterparty: leg.from === accountAddress ? leg.to : leg.from,
    });
  }
  for (const swap of swaps) {
    rows.push({
      chain, accountAddress, type: "SWAP",
      txHash: swap.txHash, blockNumber: swap.blockNumber,
      tokenInAddress: swap.tokenInAddress, amountIn: swap.amountIn,
      tokenOutAddress: swap.tokenOutAddress, amountOut: swap.amountOut,
    });
  }
  for (const event of accountEvents) {
    const decoded = decodeAccountEvent(event);
    if (!decoded) continue;
    rows.push({
      chain, accountAddress, type: decoded.type,
      txHash: event.transaction_hash, blockNumber: BigInt(event.block_number),
    });
  }

  const uniqueBlocks = [...new Set(rows.map((r) => (r.blockNumber as bigint).toString()))];
  const blockTimestamps = new Map<string, Date>(
    await mapWithConcurrency(uniqueBlocks, BLOCK_TIMESTAMP_CONCURRENCY, async (blockStr) => {
      const timestamp = await deps.getBlockTimestamp(Number(blockStr));
      return [blockStr, timestamp] as const;
    }),
  );
  for (const row of rows) {
    row.timestamp = blockTimestamps.get((row.blockNumber as bigint).toString());
  }

  if (rows.length > 0) await deps.upsertActivities(rows);
  await deps.setCursor(chain, accountAddress, BigInt(toBlock));
}

const productionDeps: SyncDeps = {
  getCursor: (chain, accountAddress) => prisma.walletActivityCursor.findUnique({ where: { chain_accountAddress: { chain, accountAddress } } }),
  getLatestBlock: async () => {
    const { callRpc } = await import("../utils/starknet.js");
    return callRpc((provider) => provider.getBlockLatestAccepted().then((b) => b.block_number));
  },
  pollEvents: pollContractEvents,
  getBlockTimestamp: async (blockNumber) => {
    const { callRpc } = await import("../utils/starknet.js");
    const block = await callRpc((provider) => provider.getBlockWithTxHashes(blockNumber));
    return new Date(block.timestamp * 1000);
  },
  upsertActivities: async (rows) => {
    for (const row of rows) {
      await prisma.walletActivity.upsert({
        where: {
          chain_txHash_type_accountAddress: {
            chain: row.chain as Chain, txHash: row.txHash as string,
            type: row.type as never, accountAddress: row.accountAddress as string,
          },
        },
        create: row as never,
        update: row as never,
      });
    }
  },
  setCursor: (chain, accountAddress, lastSyncedBlock) =>
    prisma.walletActivityCursor.upsert({
      where: { chain_accountAddress: { chain, accountAddress } },
      create: { chain, accountAddress, lastSyncedBlock },
      update: { lastSyncedBlock },
    }).then(() => undefined),
};

export function syncWalletActivityProd(chain: Chain, accountAddress: string): Promise<void> {
  return syncWalletActivity(productionDeps, chain, accountAddress);
}
