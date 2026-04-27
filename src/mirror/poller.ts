import { createProvider } from "../utils/starknet.js";
import {
  MARKETPLACE_721_CONTRACT,
  MARKETPLACE_1155_CONTRACT,
  COLLECTION_721_CONTRACT,
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  TRANSFER_SELECTOR,
  TRANSFER_SINGLE_SELECTOR,
  TRANSFER_BATCH_SELECTOR,
  COLLECTION_CREATED_SELECTOR,
  COMMENTS_CONTRACT,
  COMMENT_ADDED_SELECTOR,
  POP_FACTORY_CONTRACT,
  POP_ALLOWLIST_UPDATED_SELECTOR,
  DROP_FACTORY_CONTRACT,
  DROP_CREATED_SELECTOR,
  COLLECTION_1155_CONTRACT,
  COLLECTION_DEPLOYED_SELECTOR,
} from "../config/constants.js";
import { env } from "../config/env.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { createLogger } from "../utils/logger.js";
import { num } from "starknet";

const log = createLogger("poller");

export interface PollResult {
  events: RawStarknetEvent[];
  fromBlock: number;
  toBlock: number;
}

/**
 * Fetch all events for a block range from the marketplace contract.
 * Handles continuation token pagination internally.
 */
export async function pollEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;
  let page = 0;
  const MAX_PAGES = 100;

  do {
    const response = await provider.getEvents({
      address: MARKETPLACE_721_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [
        [
          num.toHex(ORDER_CREATED_SELECTOR),
          num.toHex(ORDER_FULFILLED_SELECTOR),
          num.toHex(ORDER_CANCELLED_SELECTOR),
        ],
      ],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
    page++;

    if (page % 10 === 0) {
      log.debug({ page, total: allEvents.length }, "Paginating events...");
    }
  } while (continuationToken && page < MAX_PAGES);

  return allEvents;
}

/**
 * Fetch OrderCreated / OrderFulfilled / OrderCancelled events from the
 * Medialane1155 (ERC-1155 marketplace) contract. Same event selectors as the
 * ERC-721 marketplace; polled separately so handlers can tell contracts apart.
 */
export async function pollEvents1155(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!MARKETPLACE_1155_CONTRACT) return [];
  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;
  let page = 0;
  const MAX_PAGES = 100;

  do {
    const response = await provider.getEvents({
      address: MARKETPLACE_1155_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [
        [
          num.toHex(ORDER_CREATED_SELECTOR),
          num.toHex(ORDER_FULFILLED_SELECTOR),
          num.toHex(ORDER_CANCELLED_SELECTOR),
        ],
      ],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
    page++;
  } while (continuationToken && page < MAX_PAGES);

  return allEvents;
}

/**
 * Fetch NFT transfer events for a specific collection contract.
 * Polls ERC-721 Transfer, ERC-1155 TransferSingle, and TransferBatch
 * in a single RPC call per page — no extra call volume vs before.
 */
export async function pollTransferEvents(
  contractAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;
  let page = 0;
  const MAX_PAGES = 100;

  do {
    const response = await provider.getEvents({
      address: contractAddress,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[
        num.toHex(TRANSFER_SELECTOR),
        num.toHex(TRANSFER_SINGLE_SELECTOR),
        num.toHex(TRANSFER_BATCH_SELECTOR),
      ]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
    page++;
  } while (continuationToken && page < MAX_PAGES);

  return allEvents;
}

/**
 * Fetch CollectionCreated events from the collection registry contract.
 */
export async function pollCollectionCreatedEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: COLLECTION_721_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(COLLECTION_CREATED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

/**
 * Fetch CommentAdded events from the NFTComments contract.
 * Returns an empty array when COMMENTS_CONTRACT is not configured.
 */
export async function pollCommentEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!COMMENTS_CONTRACT) return [];

  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: COMMENTS_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(COMMENT_ADDED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

/**
 * Fetch CollectionCreated events from the POP Protocol factory contract.
 * Returns an empty array when POP_FACTORY_ADDRESS is not configured.
 */
export async function pollPopFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!POP_FACTORY_CONTRACT) return [];

  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: POP_FACTORY_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(COLLECTION_CREATED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

/**
 * Fetch AllowlistUpdated events from a POP Protocol collection contract.
 */
export async function pollPopAllowlistEvents(
  collectionAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: collectionAddress,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(POP_ALLOWLIST_UPDATED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

/**
 * Fetch DropCreated events from the Collection Drop factory contract.
 * Returns an empty array when DROP_FACTORY_ADDRESS is not configured.
 */
export async function pollDropFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!DROP_FACTORY_CONTRACT) return [];

  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: DROP_FACTORY_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(DROP_CREATED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

/**
 * Fetch AllowlistUpdated events from a Collection Drop collection contract.
 * Uses the same selector as POP Protocol AllowlistUpdated.
 */
export async function pollDropAllowlistEvents(
  collectionAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: collectionAddress,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(POP_ALLOWLIST_UPDATED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

/**
 * Fetch CollectionDeployed events from the IP-Programmable-ERC1155-Collections factory.
 * Returns an empty array when COLLECTION_1155_CONTRACT is not configured.
 */
export async function pollERC1155FactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!COLLECTION_1155_CONTRACT) return [];

  const provider = createProvider();
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const response = await provider.getEvents({
      address: COLLECTION_1155_CONTRACT,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [[num.toHex(COLLECTION_DEPLOYED_SELECTOR)]],
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return allEvents;
}

export async function getLatestBlock(): Promise<number> {
  const provider = createProvider();
  const block = await provider.getBlockWithTxHashes("latest");
  return (block as any).block_number as number;
}
