import { num } from "starknet";
import { Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import {
  DROP_ALLOWLIST_ROOT_SET_SELECTOR,
  DROP_CLAIMED_SELECTOR,
  DROP_COLLECTION_SELECTORS,
  DROP_ISSUED_SELECTOR,
} from "../../config/constants.js";
import { pollContractEvents } from "../poller.js";
import { getBlockTimestamp } from "../../utils/blockTimestamp.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import { u256ToBigInt } from "@medialane/sdk";

const log = createLogger("mirror:dropCollection");

export type DropCollectionEvent =
  | { type: "mint"; kind: "CLAIM" | "ISSUE"; collectionAddress: string; wallet: string; quantity: string; firstTokenId: string; totalPaid: string }
  | { type: "root"; collectionAddress: string; root: string };

const hex = (v: string | bigint) => "0x" + BigInt(v).toString(16);
const u256 = (low: string | undefined, high: string | undefined) => u256ToBigInt(low ?? "0x0", high ?? "0x0").toString();
const CLAIMED = hex(DROP_CLAIMED_SELECTOR);
const ISSUED = hex(DROP_ISSUED_SELECTOR);
const ROOT_SET = hex(DROP_ALLOWLIST_ROOT_SET_SELECTOR);

export function parseDropCollectionEvent(event: RawStarknetEvent): DropCollectionEvent | null {
  const selector = event.keys[0] ? hex(event.keys[0]) : "";
  const collectionAddress = normalizeAddress("STARKNET", event.from_address);
  const d = event.data ?? [];
  if (selector === CLAIMED || selector === ISSUED) {
    if (!event.keys[1]) return null;
    return {
      type: "mint",
      kind: selector === CLAIMED ? "CLAIM" : "ISSUE",
      collectionAddress,
      wallet: normalizeAddress("STARKNET", event.keys[1]),
      quantity: u256(d[0], d[1]),
      firstTokenId: u256(d[2], d[3]),
      totalPaid: selector === CLAIMED ? u256(d[4], d[5]) : "0",
    };
  }
  if (selector === ROOT_SET) return { type: "root", collectionAddress, root: num.toHex(d[0] ?? "0x0") };
  return null;
}

/** Position of each event among its transaction's events from the same drop — stable however the events were polled. */
export function dropEventLogIndexes(events: RawStarknetEvent[]): number[] {
  const counters = new Map<string, number>();
  return events.map((e) => {
    const key = `${e.transaction_hash}:${normalizeAddress("STARKNET", e.from_address)}`;
    const i = counters.get(key) ?? 0;
    counters.set(key, i + 1);
    return i;
  });
}

/** Stamps each row with its block's time; one lookup per block. */
export async function withBlockTimes<T extends { blockNumber: bigint | number }>(
  rows: T[],
  blockTime: (block: number) => Promise<Date>,
): Promise<(T & { createdAt: Date })[]> {
  const times = new Map<bigint, Date>();
  for (const r of rows) {
    const block = BigInt(r.blockNumber);
    if (!times.has(block)) times.set(block, await blockTime(Number(block)));
  }
  return rows.map((r) => ({ ...r, createdAt: times.get(BigInt(r.blockNumber))! }));
}

/** Reduces Claimed / Issued / AllowlistRootSet; safe to run twice over the same events. */
export async function applyDropEvents(
  events: RawStarknetEvent[],
  blockTime: (block: number) => Promise<Date> = getBlockTimestamp,
): Promise<void> {
  const indexes = dropEventLogIndexes(events);
  const touched = new Set<string>();
  const mints: Prisma.DropMintCreateManyInput[] = [];
  for (const [i, event] of events.entries()) {
    const parsed = parseDropCollectionEvent(event);
    if (!parsed) continue;
    const blockNumber = BigInt(event.block_number ?? 0);
    if (parsed.type === "root") {
      // An older root never overwrites a newer one when ranges overlap.
      await prisma.drop.updateMany({
        where: { chain: "STARKNET", collectionAddress: parsed.collectionAddress, allowlistRootBlock: { lte: blockNumber } },
        data: { allowlistRoot: parsed.root, allowlistRootBlock: blockNumber },
      });
      continue;
    }
    mints.push({
      chain: "STARKNET",
      collectionAddress: parsed.collectionAddress,
      kind: parsed.kind,
      wallet: parsed.wallet,
      quantity: parsed.quantity,
      firstTokenId: parsed.firstTokenId,
      totalPaid: parsed.totalPaid,
      blockNumber,
      txHash: event.transaction_hash ?? "",
      logIndex: indexes[i]!,
    });
    touched.add(parsed.collectionAddress);
  }
  if (mints.length) await prisma.dropMint.createMany({ data: await withBlockTimes(mints, blockTime), skipDuplicates: true });
  for (const collectionAddress of touched) await recountDrop(collectionAddress);
}

/** Recomputes minted, revenue and collectors from the drop's indexed mints. */
async function recountDrop(collectionAddress: string): Promise<void> {
  const where = { chain: "STARKNET" as const, collectionAddress };
  const [all, claims, wallets] = await Promise.all([
    prisma.dropMint.aggregate({ where, _sum: { quantity: true } }),
    prisma.dropMint.aggregate({ where: { ...where, kind: "CLAIM" }, _sum: { totalPaid: true } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(DISTINCT "wallet") AS n FROM "DropMint" WHERE "chain" = 'STARKNET' AND "collectionAddress" = ${collectionAddress}`,
  ]);
  await prisma.drop.updateMany({
    where,
    data: {
      minted: all._sum.quantity ?? 0,
      revenue: claims._sum.totalPaid ?? 0,
      collectors: Number(wallets[0]?.n ?? 0n),
    },
  });
}

export interface CatchUpDeps {
  latest(): Promise<number>;
  poll(p: { address: string; fromBlock: number; toBlock: number; keys: string[][] }): Promise<RawStarknetEvent[]>;
  apply(events: RawStarknetEvent[]): Promise<void>;
}

const chainCatchUp: CatchUpDeps = {
  latest: () => callRpc((p) => p.getBlockNumber()),
  poll: (p) => pollContractEvents(p),
  apply: applyDropEvents,
};

/** A newly indexed drop's events from its creation block on, so none fall behind the collections source's cursor. */
export async function catchUpDropEvents(collection: string, fromBlock: number, deps: CatchUpDeps = chainCatchUp): Promise<void> {
  const toBlock = await deps.latest();
  if (toBlock < fromBlock) return;
  const events = await deps.poll({ address: collection, fromBlock, toBlock, keys: [DROP_COLLECTION_SELECTORS.map(hex)] });
  await deps.apply(events);
  log.debug({ collection, fromBlock, toBlock, events: events.length }, "Drop events caught up");
}
