import { num } from "starknet";
import {
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  COUNTER_INCREMENTED_SELECTOR,
  TRANSFER_SELECTOR,
  TRANSFER_SINGLE_SELECTOR,
  TRANSFER_BATCH_SELECTOR,
  COLLECTION_CREATED_SELECTOR,
} from "../config/constants.js";
import type {
  ParsedEvent,
  ParsedOrderCreated,
  ParsedOrderFulfilled,
  ParsedOrderCancelled,
  ParsedCounterIncremented,
  ParsedTransfer,
  ParsedTransferSingle,
  ParsedTransferBatch,
  ParsedCollectionCreated,
} from "../types/marketplace.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { normalizeAddress, normalizeHash } from "../utils/starknet.js";
import { u256ToBigInt } from "../utils/bigint.js";
import { createLogger } from "../utils/logger.js";
import { decodeCollectionCreatedEvent } from "./handlers/collectionCreated.js";

const log = createLogger("parser");

const SEL_ORDER_CREATED        = num.toHex(ORDER_CREATED_SELECTOR);
const SEL_ORDER_FULFILLED      = num.toHex(ORDER_FULFILLED_SELECTOR);
const SEL_ORDER_CANCELLED      = num.toHex(ORDER_CANCELLED_SELECTOR);
const SEL_TRANSFER             = num.toHex(TRANSFER_SELECTOR);
const SEL_TRANSFER_SINGLE      = num.toHex(TRANSFER_SINGLE_SELECTOR);
const SEL_TRANSFER_BATCH       = num.toHex(TRANSFER_BATCH_SELECTOR);
const SEL_COLLECTION_CREATED   = num.toHex(COLLECTION_CREATED_SELECTOR);
const SEL_COUNTER_INCREMENTED  = num.toHex(COUNTER_INCREMENTED_SELECTOR);

export function parseEvent(
  event: RawStarknetEvent,
  logIndex: number
): ParsedEvent | null {
  const keys = event.keys.map((k) => num.toHex(k));
  const selector = keys[0];
  const blockNumber = BigInt(event.block_number);
  const { from_address } = event;
  const txHash = normalizeHash(event.transaction_hash);
  const contractAddress = normalizeAddress("STARKNET", from_address);

  try {
    if (selector === SEL_ORDER_CREATED) {
      return {
        type: "OrderCreated",
        orderHash: keys[1],
        offerer: normalizeAddress("STARKNET", keys[2]),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedOrderCreated;
    }

    if (selector === SEL_ORDER_FULFILLED) {
      return {
        type: "OrderFulfilled",
        orderHash: keys[1],
        offerer: normalizeAddress("STARKNET", keys[2]),
        fulfiller: normalizeAddress("STARKNET", keys[3]),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedOrderFulfilled;
    }

    if (selector === SEL_ORDER_CANCELLED) {
      return {
        type: "OrderCancelled",
        orderHash: keys[1],
        offerer: normalizeAddress("STARKNET", keys[2]),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedOrderCancelled;
    }

    if (selector === SEL_COUNTER_INCREMENTED) {

      return {
        type: "CounterIncremented",
        offerer: normalizeAddress("STARKNET", keys[1]),
        newCounter: BigInt(event.data[0]).toString(),
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedCounterIncremented;
    }

    if (selector === SEL_TRANSFER) {

      if (keys.length >= 5) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress("STARKNET", keys[1]),
          to: normalizeAddress("STARKNET", keys[2]),
          tokenId: u256ToBigInt(keys[3], keys[4]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }

      if (keys.length === 4) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress("STARKNET", keys[1]),
          to: normalizeAddress("STARKNET", keys[2]),
          tokenId: BigInt(keys[3]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }

      if (keys.length === 3 && event.data.length >= 2) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress("STARKNET", keys[1]),
          to: normalizeAddress("STARKNET", keys[2]),
          tokenId: u256ToBigInt(event.data[0], event.data[1]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }

      if (keys.length === 1 && event.data.length >= 4) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress("STARKNET", event.data[0]),
          to: normalizeAddress("STARKNET", event.data[1]),
          tokenId: u256ToBigInt(event.data[2], event.data[3]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }
    }

    if (selector === SEL_TRANSFER_SINGLE) {

      if (keys.length >= 4 && event.data.length >= 4) {
        return {
          type: "TransferSingle",
          contractAddress,
          operator: normalizeAddress("STARKNET", keys[1]),
          from: normalizeAddress("STARKNET", keys[2]),
          to: normalizeAddress("STARKNET", keys[3]),
          tokenId: u256ToBigInt(event.data[0], event.data[1]).toString(),
          amount: u256ToBigInt(event.data[2], event.data[3]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransferSingle;
      }
    }

    if (selector === SEL_TRANSFER_BATCH) {

      if (keys.length >= 4 && event.data.length >= 1) {
        const data = event.data;
        const idsLen = Number(BigInt(data[0]));

        const idsEnd = 1 + idsLen * 2;
        if (data.length < idsEnd + 1) return null;
        const amountsLen = Number(BigInt(data[idsEnd]));
        if (idsLen !== amountsLen) {
          log.warn({ txHash, idsLen, amountsLen }, "TransferBatch ids/amounts length mismatch — skipping");
          return null;
        }
        const transfers: Array<{ tokenId: string; amount: string }> = [];
        for (let i = 0; i < idsLen; i++) {
          const idOffset = 1 + i * 2;
          const amtOffset = idsEnd + 1 + i * 2;
          if (amtOffset + 1 >= data.length) break;
          transfers.push({
            tokenId: u256ToBigInt(data[idOffset], data[idOffset + 1]).toString(),
            amount: u256ToBigInt(data[amtOffset], data[amtOffset + 1]).toString(),
          });
        }
        if (transfers.length === 0) return null;
        return {
          type: "TransferBatch",
          contractAddress,
          operator: normalizeAddress("STARKNET", keys[1]),
          from: normalizeAddress("STARKNET", keys[2]),
          to: normalizeAddress("STARKNET", keys[3]),
          transfers,
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransferBatch;
      }
    }

    if (selector === SEL_COLLECTION_CREATED) {
      const decoded = decodeCollectionCreatedEvent({ keys, data: event.data });
      if (!decoded) return null;
      return {
        type: "CollectionCreated",
        collectionId: decoded.collectionId,
        owner: decoded.owner,
        blockNumber,
        txHash,
        logIndex,
      } satisfies ParsedCollectionCreated;
    }
  } catch (err) {
    log.warn({ err, selector, txHash }, "Failed to parse event");
  }

  return null;
}

export function parseEvents(events: RawStarknetEvent[]): ParsedEvent[] {

  const txCounters = new Map<string, number>();
  const results: ParsedEvent[] = [];
  for (const event of events) {
    const txHash = normalizeHash(event.transaction_hash);
    const n = txCounters.get(txHash) ?? 0;
    txCounters.set(txHash, n + 1);
    const parsed = parseEvent(event, n);
    if (parsed) results.push(parsed);
  }
  return results;
}
