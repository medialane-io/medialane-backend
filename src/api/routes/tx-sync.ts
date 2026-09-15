import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db/client.js";
import { callRpc } from "../../utils/starknet.js";
import { applyEvents, applyCollectionsCreated } from "../../mirror/apply.js";
import { CHAIN } from "../../mirror/index.js";
import {
  CORE_FACTORY_DATA_TOKENIZATION,
  CORE_FACTORY_MIP721,
  CORE_MARKETPLACE_1155,
  CORE_MARKETPLACE_721,
  EVENT_SOURCES,
  type EventSource,
} from "../../mirror/sources.js";
import { normalizeAddress } from "../../utils/starknet.js";
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

const POLLED_CONTRACT_SOURCES = new Set([
  CORE_MARKETPLACE_721,
  CORE_MARKETPLACE_1155,
  CORE_FACTORY_MIP721,
  CORE_FACTORY_DATA_TOKENIZATION,
]);

export function polledContracts(): Set<string> {
  const contracts = new Set<string>();
  for (const source of EVENT_SOURCES) {
    if (!POLLED_CONTRACT_SOURCES.has(source.id)) continue;
    if (source.scope.kind === "contract" && source.scope.address) {
      contracts.add(normalizeAddress("STARKNET", source.scope.address));
    }
  }
  return contracts;
}

export function emittingContracts(events: RawStarknetEvent[]): string[] {
  return [...new Set(events.map((e) => normalizeAddress("STARKNET", e.from_address)))];
}

export function eventsFromTrackedContracts(events: RawStarknetEvent[], tracked: Set<string>): RawStarknetEvent[] {
  return events.filter((e) => tracked.has(normalizeAddress("STARKNET", e.from_address)));
}

const RECEIPT_APPLIED_FACTORY_SOURCES = new Set([
  "factory:pop",
  "factory:drop",
  "factory:mip-erc1155",
  "factory:ip-tickets",
  "factory:ip-club",
  "factory:creator-coin",
]);

export interface FactoryBatch {
  source: EventSource;
  events: RawStarknetEvent[];
}

function sameFelt(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

export function factoryBatches(events: RawStarknetEvent[]): FactoryBatch[] {
  const batches: FactoryBatch[] = [];
  for (const source of EVENT_SOURCES) {
    if (!RECEIPT_APPLIED_FACTORY_SOURCES.has(source.id) || !source.apply) continue;
    if (source.scope.kind !== "contract" || !source.scope.address) continue;
    const factory = normalizeAddress("STARKNET", source.scope.address);
    const matched = events.filter(
      (e) =>
        normalizeAddress("STARKNET", e.from_address) === factory &&
        source.selectors.some((selector) => sameFelt(e.keys[0], selector)),
    );
    if (matched.length > 0) batches.push({ source, events: matched });
  }
  return batches;
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

  const receiptEvents = eventsFromReceipt(receipt, txHash, blockNumber);
  const affectedContracts = new Set<string>();

  const deployed = factoryBatches(receiptEvents);
  for (const batch of deployed) {
    await batch.source.apply!(batch.events, { affectedContracts });
  }

  const knownCollections = await prisma.collection.findMany({
    where: { chain: CHAIN, contractAddress: { in: emittingContracts(receiptEvents) } },
    select: { contractAddress: true },
  });
  const tracked = polledContracts();
  for (const collection of knownCollections) tracked.add(collection.contractAddress);

  const events = eventsFromTrackedContracts(receiptEvents, tracked);
  if (events.length === 0 && deployed.length === 0) {
    return c.json({ data: { applied: 0, pending: false } });
  }

  let applied = deployed.reduce((n, batch) => n + batch.events.length, 0);
  if (events.length > 0) {
    const outcome = await prisma.$transaction(
      (tx) => applyEvents(events, tx, CHAIN),
      { timeout: 30000 },
    );
    for (const contractAddress of await applyCollectionsCreated(outcome.parsed, CHAIN)) {
      outcome.affectedContracts.add(contractAddress);
    }
    for (const contractAddress of outcome.affectedContracts) affectedContracts.add(contractAddress);
    applied += outcome.parsed.length;
  }

  for (const contractAddress of affectedContracts) {
    worker.enqueue({ type: "STATS_UPDATE", chain: CHAIN, contractAddress });
  }

  const pendingTokens = await prisma.token.findMany({
    where: {
      chain: CHAIN,
      contractAddress: { in: [...affectedContracts] },
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

  log.info({ txHash, applied }, "transaction applied ahead of the poll");

  return c.json({
    data: {
      applied,
      contracts: [...affectedContracts],
      pending: false,
    },
  });
});

export default txSync;
