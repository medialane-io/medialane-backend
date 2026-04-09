import { num } from "starknet";
import {
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
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
  ParsedTransfer,
  ParsedTransferSingle,
  ParsedTransferBatch,
  ParsedCollectionCreated,
} from "../types/marketplace.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { normalizeAddress } from "../utils/starknet.js";
import { u256ToBigInt } from "../utils/bigint.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("parser");

// Precompute hex selectors once at module load — avoids repeated conversion per event
const SEL_ORDER_CREATED        = num.toHex(ORDER_CREATED_SELECTOR);
const SEL_ORDER_FULFILLED      = num.toHex(ORDER_FULFILLED_SELECTOR);
const SEL_ORDER_CANCELLED      = num.toHex(ORDER_CANCELLED_SELECTOR);
const SEL_TRANSFER             = num.toHex(TRANSFER_SELECTOR);
const SEL_TRANSFER_SINGLE      = num.toHex(TRANSFER_SINGLE_SELECTOR);
const SEL_TRANSFER_BATCH       = num.toHex(TRANSFER_BATCH_SELECTOR);
const SEL_COLLECTION_CREATED   = num.toHex(COLLECTION_CREATED_SELECTOR);

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

    if (selector === SEL_TRANSFER) {
      // Cairo 1 ERC-721: keys = [selector, from, to, tokenId.low, tokenId.high]
      if (keys.length >= 5) {
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
      // Cairo 0 ERC-721: keys = [selector, from, to, tokenId] (tokenId as felt252)
      if (keys.length === 4) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress(keys[1]),
          to: normalizeAddress(keys[2]),
          tokenId: BigInt(keys[3]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }
      // Cairo 0 ERC-721: keys = [selector, from, to], tokenId as u256 in data
      if (keys.length === 3 && event.data.length >= 2) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress(keys[1]),
          to: normalizeAddress(keys[2]),
          tokenId: u256ToBigInt(event.data[0], event.data[1]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }
      // Cairo 0 ERC-721 (old format): only selector in keys, all fields in data
      // data = [from, to, tokenId.low, tokenId.high]
      if (keys.length === 1 && event.data.length >= 4) {
        return {
          type: "Transfer",
          contractAddress,
          from: normalizeAddress(event.data[0]),
          to: normalizeAddress(event.data[1]),
          tokenId: u256ToBigInt(event.data[2], event.data[3]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransfer;
      }
    }

    if (selector === SEL_TRANSFER_SINGLE) {
      // ERC-1155 TransferSingle
      // keys = [selector, operator, from, to]
      // data = [tokenId.low, tokenId.high, amount.low, amount.high]
      if (keys.length >= 4 && event.data.length >= 4) {
        return {
          type: "TransferSingle",
          contractAddress,
          operator: normalizeAddress(keys[1]),
          from: normalizeAddress(keys[2]),
          to: normalizeAddress(keys[3]),
          tokenId: u256ToBigInt(event.data[0], event.data[1]).toString(),
          amount: u256ToBigInt(event.data[2], event.data[3]).toString(),
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransferSingle;
      }
    }

    if (selector === SEL_TRANSFER_BATCH) {
      // ERC-1155 TransferBatch
      // keys = [selector, operator, from, to]
      // data = [ids_len, id0.low, id0.high, ..., amounts_len, amount0.low, amount0.high, ...]
      if (keys.length >= 4 && event.data.length >= 1) {
        const data = event.data;
        const idsLen = Number(BigInt(data[0]));
        // Each id is a u256 (2 felts). IDs start at data[1].
        const idsEnd = 1 + idsLen * 2;
        if (data.length < idsEnd + 1) return null; // malformed
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
          operator: normalizeAddress(keys[1]),
          from: normalizeAddress(keys[2]),
          to: normalizeAddress(keys[3]),
          transfers,
          blockNumber,
          txHash,
          logIndex,
        } satisfies ParsedTransferBatch;
      }
    }

    if (selector === SEL_COLLECTION_CREATED) {
      // CollectionCreated data: [collection_id.low, collection_id.high, owner, ...ByteArrays]
      const data = event.data;
      if (!data || data.length < 3) return null;
      const collectionId = (BigInt(data[0]) + (BigInt(data[1]) << 128n)).toString();
      const owner = normalizeAddress(data[2]);
      return {
        type: "CollectionCreated",
        collectionId,
        owner,
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
  // Assign logIndex per-transaction (0 = first event from that tx, 1 = second, etc.)
  // so that the unique constraint [chain, txHash, logIndex] stays stable across
  // re-processing — regardless of where each event falls in the overall batch array.
  const txCounters = new Map<string, number>();
  const results: ParsedEvent[] = [];
  for (const event of events) {
    const n = txCounters.get(event.transaction_hash) ?? 0;
    txCounters.set(event.transaction_hash, n + 1);
    const parsed = parseEvent(event, n);
    if (parsed) results.push(parsed);
  }
  return results;
}
