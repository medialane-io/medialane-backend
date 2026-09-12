import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import { callRpc } from "../../utils/starknet.js";
import { applyEvents } from "../../mirror/apply.js";
import { CHAIN } from "../../mirror/index.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:tx-sync");

export interface ReceiptEvent {
  from_address?: string;
  keys?: string[];
  data?: string[];
}

export function eventsFromReceipt(
  receipt: unknown,
  txHash: string,
  blockNumber: number,
): RawStarknetEvent[] {
  const events = (receipt as { events?: ReceiptEvent[] } | null)?.events ?? [];
  return events
    .filter((e) => e.from_address && e.keys?.length)
    .map((e) => ({
      from_address: e.from_address!,
      keys: e.keys!,
      data: e.data ?? [],
      block_number: blockNumber,
      transaction_hash: txHash,
    })) as unknown as RawStarknetEvent[];
}

export function blockNumberOf(receipt: unknown): number | null {
  const n = (receipt as { block_number?: unknown } | null)?.block_number;
  return typeof n === "number" ? n : null;
}

const txSync = new Hono<AppEnv>();

txSync.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ txHash: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "txHash required" }, 400);

  const { txHash } = parsed.data;

  let receipt: unknown;
  try {
    receipt = await callRpc((provider) => provider.getTransactionReceipt(txHash));
  } catch (err) {
    log.warn({ err, txHash }, "receipt unavailable");
    return c.json({ error: "Transaction not found yet" }, 404);
  }

  const blockNumber = blockNumberOf(receipt);
  if (blockNumber === null) {
    return c.json({ data: { applied: 0, pending: true } });
  }

  const events = eventsFromReceipt(receipt, txHash, blockNumber);
  if (events.length === 0) {
    return c.json({ data: { applied: 0, pending: false } });
  }

  const outcome = await prisma.$transaction(
    (tx) => applyEvents(events, tx, CHAIN),
    { timeout: 30000 },
  );

  for (const contractAddress of outcome.affectedContracts) {
    worker.enqueue({ type: "STATS_UPDATE", chain: CHAIN, contractAddress });
  }

  const pendingTokens = await prisma.token.findMany({
    where: {
      chain: CHAIN,
      contractAddress: { in: [...outcome.affectedContracts] },
      metadataStatus: "PENDING",
      tokenUri: null,
    },
    select: { contractAddress: true, tokenId: true },
    take: 200,
  });
  for (const token of pendingTokens) {
    worker.enqueue({
      type: "METADATA_FETCH",
      chain: CHAIN,
      contractAddress: token.contractAddress,
      tokenId: token.tokenId,
    });
  }

  log.info({ txHash, applied: outcome.parsed.length }, "transaction applied ahead of the poll");

  return c.json({
    data: {
      applied: outcome.parsed.length,
      contracts: [...outcome.affectedContracts],
      pending: false,
    },
  });
});

export default txSync;
