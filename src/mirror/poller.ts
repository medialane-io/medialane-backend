import { createProvider } from "../utils/starknet.js";
import {
  MARKETPLACE_CONTRACT,
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  TRANSFER_SELECTOR,
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
      address: MARKETPLACE_CONTRACT,
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
 * Fetch ERC-721 Transfer events for a specific collection contract.
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
      keys: [[num.toHex(TRANSFER_SELECTOR)]],
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

export async function getLatestBlock(): Promise<number> {
  const provider = createProvider();
  const block = await provider.getBlockWithTxHashes("latest");
  return (block as any).block_number as number;
}
