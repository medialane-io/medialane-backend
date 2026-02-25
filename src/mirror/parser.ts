import { num } from "starknet";
import {
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  TRANSFER_SELECTOR,
} from "../config/constants.js";
import type {
  ParsedEvent,
  ParsedOrderCreated,
  ParsedOrderFulfilled,
  ParsedOrderCancelled,
  ParsedTransfer,
} from "../types/marketplace.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { normalizeAddress } from "../utils/starknet.js";
import { u256ToBigInt } from "../utils/bigint.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("parser");

// Precompute hex selectors once at module load — avoids repeated conversion per event
const SEL_ORDER_CREATED   = num.toHex(ORDER_CREATED_SELECTOR);
const SEL_ORDER_FULFILLED = num.toHex(ORDER_FULFILLED_SELECTOR);
const SEL_ORDER_CANCELLED = num.toHex(ORDER_CANCELLED_SELECTOR);
const SEL_TRANSFER        = num.toHex(TRANSFER_SELECTOR);

export function parseEvent(
  event: RawStarknetEvent,
  logIndex: number
): ParsedEvent | null {
  const keys = event.keys.map((k) => num.toHex(k));
  const selector = keys[0];
  const blockNumber = BigInt(event.block_number);
  const { transaction_hash: txHash, from_address } = event;
  const contractAddress = normalizeAddress(from_address);

  try {
    if (selector === SEL_ORDER_CREATED) {
      return {
        type: "OrderCreated",
        orderHash: keys[1],
        offerer: normalizeAddress(keys[2]),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedOrderCreated;
    }

    if (selector === SEL_ORDER_FULFILLED) {
      return {
        type: "OrderFulfilled",
        orderHash: keys[1],
        offerer: normalizeAddress(keys[2]),
        fulfiller: normalizeAddress(keys[3]),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedOrderFulfilled;
    }

    if (selector === SEL_ORDER_CANCELLED) {
      return {
        type: "OrderCancelled",
        orderHash: keys[1],
        offerer: normalizeAddress(keys[2]),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedOrderCancelled;
    }

    if (selector === SEL_TRANSFER && keys.length >= 5) {
      // ERC-721 Transfer: keys = [selector, from, to, tokenId.low, tokenId.high]
      return {
        type: "Transfer",
        contractAddress,
        from: normalizeAddress(keys[1]),
        to: normalizeAddress(keys[2]),
        tokenId: u256ToBigInt(keys[3], keys[4]).toString(),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedTransfer;
    }
  } catch (err) {
    log.warn({ err, selector, txHash }, "Failed to parse event");
  }

  return null;
}

export function parseEvents(events: RawStarknetEvent[]): ParsedEvent[] {
  const results: ParsedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const parsed = parseEvent(events[i], i);
    if (parsed) results.push(parsed);
  }
  return results;
}
