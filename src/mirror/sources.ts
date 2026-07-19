import { num } from "starknet";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { normalizeAddress } from "../utils/starknet.js";
import { pollContractEvents } from "./poller.js";
import { loadSourceCursor } from "./cursor.js";
import { mapWithConcurrency } from "../utils/retry.js";
import {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_COLLECTION_1155_CONTRACT,
  STARKNET_POP_FACTORY_CONTRACT,
  STARKNET_DROP_FACTORY_CONTRACT,
  STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
  STARKNET_NFTCOMMENTS_CONTRACT,
  STARKNET_IP_TICKETS_FACTORY_CONTRACT,
  STARKNET_IP_CLUB_FACTORY_CONTRACT,
  STARKNET_IP_SPONSORSHIP_CONTRACT,
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  COUNTER_INCREMENTED_SELECTOR,
  TRANSFER_SELECTOR,
  TRANSFER_SINGLE_SELECTOR,
  TRANSFER_BATCH_SELECTOR,
  COLLECTION_CREATED_SELECTOR,
  COLLECTION_DEPLOYED_SELECTOR,
  CLUB_DEPLOYED_SELECTOR,
  COMMENT_ADDED_SELECTOR,
  POP_ALLOWLIST_UPDATED_SELECTOR,
  DROP_CREATED_SELECTOR,
  CREATOR_COIN_CREATED_SELECTOR,
  OFFER_CREATED_SELECTOR,
  OFFER_STATUS_UPDATED_SELECTOR,
  BID_PLACED_SELECTOR,
  BID_RETRACTED_SELECTOR,
  SPONSORSHIP_ACCEPTED_SELECTOR,
  PROPOSAL_CREATED_SELECTOR,
  PROPOSAL_CLOSED_SELECTOR,
  PROPOSAL_ACCEPTED_SELECTOR,
  LICENSE_MINTED_SELECTOR,
} from "../config/constants.js";
import { handleCommentAdded } from "./handlers/commentAdded.js";
import { handlePopCollectionCreated, handlePopAllowlistUpdated } from "./handlers/popFactory.js";
import { handleDropCreated, handleDropAllowlistUpdated } from "./handlers/dropFactory.js";
import { handleCreatorCoinCreated } from "./handlers/creatorCoinFactory.js";
import { handleIP1155CollectionDeployed } from "./handlers/ip1155Factory.js";
import { handleIPTicketsCollectionDeployed } from "./handlers/ipTicketsFactory.js";
import { handleIPClubDeployed } from "./handlers/ipClubFactory.js";
import { applySponsorship } from "./handlers/sponsorship.js";
import type { Chain } from "@prisma/client";
import type { RawStarknetEvent } from "../types/starknet.js";

/**
 * The declarative event-source table — the ONE place a digital-asset service
 * plugs into the mirror. Every source is the same shape: where to poll
 * (a fixed contract, or a fan-out over known Collection rows), which event
 * selectors, how often, and how to reduce the events.
 *
 * Core sources (no `apply`) feed the tick's atomic parse/write transaction
 * and share the main IndexerCursor. Side sources reduce post-transaction via
 * `apply`. Slow-cadence sources (`cadenceMs` set) persist their position in
 * SourceCursor — restart-safe, no in-memory shadow cursors.
 *
 * Adding a service = one entry here (+ its decode handler). No new pollers,
 * no new cursors, no tick edits, no tables, no routes.
 */
export interface SourceContext {
  /** Contracts touched this tick — drives METADATA_FETCH / STATS_UPDATE enqueues. */
  affectedContracts: Set<string>;
}

export interface EventSource {
  id: string;
  scope:
    | { kind: "contract"; address: string | undefined }
    | { kind: "collections"; service?: string };
  selectors: string[];
  /** Omit = every tick over the main cursor window. Set = slow schedule + durable SourceCursor. */
  cadenceMs?: number;
  maxPages?: number;
  /** Post-transaction reducer. Core sources consumed by the tick pipeline omit this. */
  apply?: (events: RawStarknetEvent[], ctx: SourceContext) => Promise<void>;
}

export interface SourceFetch {
  source: EventSource;
  events: RawStarknetEvent[];
  /** Block the source's durable cursor should advance to; null for every-tick sources. */
  cursorTo: number | null;
}

const hex = (selector: string) => num.toHex(selector);

/** Max in-flight getEvents calls when a source fans out over Collection rows. */
const COLLECTION_POLL_CONCURRENCY = 8;

const MARKETPLACE_SELECTORS = [
  hex(ORDER_CREATED_SELECTOR),
  hex(ORDER_FULFILLED_SELECTOR),
  hex(ORDER_CANCELLED_SELECTOR),
  hex(COUNTER_INCREMENTED_SELECTOR),
];

export const CORE_MARKETPLACE_721 = "marketplace-721";
export const CORE_MARKETPLACE_1155 = "marketplace-1155";
export const CORE_FACTORY_MIP721 = "factory:mip-erc721";
export const CORE_TRANSFERS = "transfers";

async function applyComments(events: RawStarknetEvent[]): Promise<void> {
  const txCounters: Record<string, number> = {};
  for (const event of events) {
    const txHash = event.transaction_hash ?? "";
    const logIndex = txCounters[txHash] ?? 0;
    txCounters[txHash] = logIndex + 1;
    await handleCommentAdded(event, txHash, logIndex);
  }
}

async function applyPopFactory(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  for (const event of events) {
    await handlePopCollectionCreated(event);
    if (event.data?.[0]) ctx.affectedContracts.add(normalizeAddress("STARKNET", event.data[0]));
  }
}

async function applyDropFactory(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  for (const event of events) {
    await handleDropCreated(event);
    if (event.data?.[0]) ctx.affectedContracts.add(normalizeAddress("STARKNET", event.data[0]));
  }
}

async function applyIp1155Factory(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  for (const event of events) {
    await handleIP1155CollectionDeployed(event);
    if (event.keys?.[1]) ctx.affectedContracts.add(normalizeAddress("STARKNET", event.keys[1]));
  }
}

async function applyIpTicketsFactory(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  for (const event of events) {
    await handleIPTicketsCollectionDeployed(event);
    if (event.keys?.[1]) ctx.affectedContracts.add(normalizeAddress("STARKNET", event.keys[1]));
  }
}

async function applyIpClubFactory(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  for (const event of events) {
    await handleIPClubDeployed(event);
    if (event.keys?.[1]) ctx.affectedContracts.add(normalizeAddress("STARKNET", event.keys[1]));
  }
}

async function applyCreatorCoinFactory(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  for (const event of events) {
    await handleCreatorCoinCreated(event);
    if (event.data?.[5]) ctx.affectedContracts.add(normalizeAddress("STARKNET", event.data[5]));
  }
}

async function applyPopAllowlist(events: RawStarknetEvent[]): Promise<void> {
  for (const event of events) await handlePopAllowlistUpdated(event);
}

async function applyDropAllowlist(events: RawStarknetEvent[]): Promise<void> {
  for (const event of events) await handleDropAllowlistUpdated(event);
}

export const EVENT_SOURCES: EventSource[] = [
  { id: CORE_MARKETPLACE_721, scope: { kind: "contract", address: STARKNET_MARKETPLACE_721_CONTRACT }, selectors: MARKETPLACE_SELECTORS, maxPages: 100 },
  { id: CORE_MARKETPLACE_1155, scope: { kind: "contract", address: STARKNET_MARKETPLACE_1155_CONTRACT }, selectors: MARKETPLACE_SELECTORS, maxPages: 100 },
  { id: CORE_FACTORY_MIP721, scope: { kind: "contract", address: STARKNET_COLLECTION_721_CONTRACT }, selectors: [hex(COLLECTION_CREATED_SELECTOR)] },
  // Transfers fan out over every known collection — slow cadence keeps RPC
  // volume flat (one call per collection per interval, not per tick).
  { id: CORE_TRANSFERS, scope: { kind: "collections" }, selectors: [hex(TRANSFER_SELECTOR), hex(TRANSFER_SINGLE_SELECTOR), hex(TRANSFER_BATCH_SELECTOR)], cadenceMs: env.TRANSFER_POLL_INTERVAL_MS, maxPages: 100 },
  { id: "comments", scope: { kind: "contract", address: STARKNET_NFTCOMMENTS_CONTRACT }, selectors: [hex(COMMENT_ADDED_SELECTOR)], apply: applyComments },
  // Launchpad services (POP, Drop's allowlist aside, Tickets, Club, Sponsorship)
  // are low-traffic relative to the marketplace/mip-erc721 core tick — all
  // share LAUNCHPAD_POLL_INTERVAL_MS (default 50s) instead of polling every
  // ~10s main tick.
  { id: "factory:pop", scope: { kind: "contract", address: STARKNET_POP_FACTORY_CONTRACT }, selectors: [hex(COLLECTION_CREATED_SELECTOR)], cadenceMs: env.LAUNCHPAD_POLL_INTERVAL_MS, apply: applyPopFactory },
  { id: "factory:drop", scope: { kind: "contract", address: STARKNET_DROP_FACTORY_CONTRACT }, selectors: [hex(DROP_CREATED_SELECTOR)], cadenceMs: env.LAUNCHPAD_POLL_INTERVAL_MS, apply: applyDropFactory },
  { id: "factory:mip-erc1155", scope: { kind: "contract", address: STARKNET_COLLECTION_1155_CONTRACT }, selectors: [hex(COLLECTION_DEPLOYED_SELECTOR)], cadenceMs: env.LAUNCHPAD_POLL_INTERVAL_MS, apply: applyIp1155Factory },
  { id: "factory:ip-tickets", scope: { kind: "contract", address: STARKNET_IP_TICKETS_FACTORY_CONTRACT }, selectors: [hex(COLLECTION_DEPLOYED_SELECTOR)], cadenceMs: env.LAUNCHPAD_POLL_INTERVAL_MS, apply: applyIpTicketsFactory },
  { id: "factory:ip-club", scope: { kind: "contract", address: STARKNET_IP_CLUB_FACTORY_CONTRACT }, selectors: [hex(CLUB_DEPLOYED_SELECTOR)], cadenceMs: env.LAUNCHPAD_POLL_INTERVAL_MS, apply: applyIpClubFactory },
  {
    id: "ip-sponsorship",
    scope: { kind: "contract", address: STARKNET_IP_SPONSORSHIP_CONTRACT },
    selectors: [
      hex(OFFER_CREATED_SELECTOR), hex(OFFER_STATUS_UPDATED_SELECTOR), hex(BID_PLACED_SELECTOR),
      hex(BID_RETRACTED_SELECTOR), hex(SPONSORSHIP_ACCEPTED_SELECTOR), hex(PROPOSAL_CREATED_SELECTOR),
      hex(PROPOSAL_CLOSED_SELECTOR), hex(PROPOSAL_ACCEPTED_SELECTOR), hex(LICENSE_MINTED_SELECTOR),
    ],
    cadenceMs: env.LAUNCHPAD_POLL_INTERVAL_MS,
    apply: applySponsorship,
  },
  { id: "factory:creator-coin", scope: { kind: "contract", address: STARKNET_CREATOR_COIN_FACTORY_CONTRACT }, selectors: [hex(CREATOR_COIN_CREATED_SELECTOR)], cadenceMs: env.CREATOR_COIN_POLL_INTERVAL_MS, apply: applyCreatorCoinFactory },
  { id: "allowlist:pop", scope: { kind: "collections", service: "pop-protocol" }, selectors: [hex(POP_ALLOWLIST_UPDATED_SELECTOR)], cadenceMs: env.TRANSFER_POLL_INTERVAL_MS, apply: applyPopAllowlist },
  { id: "allowlist:drop", scope: { kind: "collections", service: "drop-collection" }, selectors: [hex(POP_ALLOWLIST_UPDATED_SELECTOR)], cadenceMs: env.TRANSFER_POLL_INTERVAL_MS, apply: applyDropAllowlist },
];

export function isDue(cadenceMs: number | undefined, lastPollTime: number | undefined, now: number): boolean {
  if (cadenceMs === undefined) return true; // every-tick source
  if (lastPollTime === undefined) return true; // never polled this process
  return now - lastPollTime >= cadenceMs;
}

export function sourceFromBlock(lastBlock: bigint | null, mainFromBlock: number): number {
  return lastBlock != null ? Number(lastBlock) + 1 : mainFromBlock;
}

// Cadence timing only — the block POSITION is durable in SourceCursor. A
// restart resets timers (harmless: due sources poll immediately, from their
// durable cursor).
const _lastPollTime = new Map<string, number>();

export async function fetchDueSources(params: {
  chain: Chain;
  fromBlock: number;
  toBlock: number;
  now: number;
}): Promise<SourceFetch[]> {
  const { chain, fromBlock, toBlock, now } = params;
  const fetches: SourceFetch[] = [];

  for (const source of EVENT_SOURCES) {
    if (source.scope.kind === "contract" && !source.scope.address) continue;
    if (!isDue(source.cadenceMs, _lastPollTime.get(source.id), now)) continue;

    let from = fromBlock;
    let cursorTo: number | null = null;
    if (source.cadenceMs !== undefined) {
      from = sourceFromBlock(await loadSourceCursor(chain, source.id), fromBlock);
      cursorTo = toBlock;
      _lastPollTime.set(source.id, now);
    }

    let events: RawStarknetEvent[] = [];
    if (from <= toBlock) {
      if (source.scope.kind === "contract") {
        events = await pollContractEvents({
          address: source.scope.address!,
          fromBlock: from,
          toBlock,
          keys: [source.selectors],
          maxPages: source.maxPages,
        });
      } else {
        const collections = await prisma.collection.findMany({
          where: source.scope.service
            ? { chain, service: source.scope.service, startBlock: { lte: BigInt(toBlock) } }
            : { chain, startBlock: { lte: BigInt(toBlock) } },
          select: { contractAddress: true },
        });
        // Bounded fan-out: one getEvents call per collection, at most
        // COLLECTION_POLL_CONCURRENCY in flight — the burst stays flat as the
        // collection count grows (the pattern every chain ingestor follows).
        events = (
          await mapWithConcurrency(collections, COLLECTION_POLL_CONCURRENCY, (c) =>
            pollContractEvents({
              address: c.contractAddress,
              fromBlock: from,
              toBlock,
              keys: [source.selectors],
              maxPages: source.maxPages,
            })
          )
        ).flat();
      }
    }

    fetches.push({ source, events, cursorTo });
  }

  return fetches;
}
