import { num } from "starknet";
import type { Prisma } from "@prisma/client";
import { parseEvents } from "./parser.js";
import { handleOrderCreated, handleOrderCreated1155 } from "./handlers/orderCreated.js";
import { handleOrderFulfilled, parseRawOrderFulfilled1155 } from "./handlers/orderFulfilled.js";
import { handleOrderCancelled } from "./handlers/orderCancelled.js";
import { handleCounterIncremented } from "./handlers/counterIncremented.js";
import { cleanupGhostListings } from "./handlers/ghostListingCleanup.js";
import { dispatchTransfer } from "./handlers/transfer.js";
import { normalizeAddress } from "../utils/starknet.js";
import {
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  COUNTER_INCREMENTED_SELECTOR,
  STARKNET_MARKETPLACE_1155_CONTRACT,
} from "../config/constants.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import type { ParsedTransfer, ParsedTransferSingle } from "../types/marketplace.js";

export type Chain = "STARKNET";

export interface ApplyOutcome {
  parsed: ReturnType<typeof parseEvents>;
  affectedContracts: Set<string>;
  orderNftContracts: Set<string>;
  fulfilledOrCancelledHashes: string[];
}

export function isMarketplace1155Event(event: RawStarknetEvent): boolean {
  if (!STARKNET_MARKETPLACE_1155_CONTRACT || !event.from_address) return false;
  return (
    normalizeAddress("STARKNET", event.from_address) ===
    normalizeAddress("STARKNET", STARKNET_MARKETPLACE_1155_CONTRACT)
  );
}

export function deduplicateTransfers(
  parsed: ReturnType<typeof parseEvents>,
): ReturnType<typeof parseEvents> {
  const fingerprint = (e: ParsedTransfer | ParsedTransferSingle) =>
    `${e.txHash}:${e.contractAddress}:${e.tokenId}:${e.from}:${e.to}`;

  const singles = new Set(
    parsed
      .filter((e): e is ParsedTransferSingle => e.type === "TransferSingle")
      .map(fingerprint),
  );

  return parsed.filter((e) => {
    if (e.type !== "Transfer") return true;
    return !singles.has(fingerprint(e as ParsedTransfer));
  });
}

export async function applyEvents(
  raw: RawStarknetEvent[],
  tx: Prisma.TransactionClient,
  chain: Chain,
): Promise<ApplyOutcome> {
  const marketplace1155 = raw.filter(isMarketplace1155Event);
  const rest = raw.filter((e) => !isMarketplace1155Event(e));

  const parsed = deduplicateTransfers(parseEvents(rest));

  const affectedContracts = new Set<string>();
  const orderNftContracts = new Set<string>();
  const fulfilledOrCancelledHashes: string[] = [];

  for (const event of parsed) {
    switch (event.type) {
      case "OrderCreated": {
        const nftContract = await handleOrderCreated(event, tx, chain);
        if (nftContract) orderNftContracts.add(nftContract);
        break;
      }
      case "OrderFulfilled":
        await handleOrderFulfilled(event, tx, chain);
        await cleanupGhostListings(event.orderHash, tx, chain);
        fulfilledOrCancelledHashes.push(event.orderHash);
        break;
      case "OrderCancelled":
        await handleOrderCancelled(event, tx, chain);
        fulfilledOrCancelledHashes.push(event.orderHash);
        break;
      case "CounterIncremented":
        await handleCounterIncremented(event, tx, chain);
        break;
      case "Transfer":
      case "TransferSingle":
      case "TransferBatch":
        await dispatchTransfer(event, tx, chain);
        affectedContracts.add(event.contractAddress);
        break;
    }
  }

  await applyMarketplace1155(marketplace1155, tx, chain, {
    orderNftContracts,
    fulfilledOrCancelledHashes,
  });

  return { parsed, affectedContracts, orderNftContracts, fulfilledOrCancelledHashes };
}

async function applyMarketplace1155(
  events: RawStarknetEvent[],
  tx: Prisma.TransactionClient,
  chain: Chain,
  out: { orderNftContracts: Set<string>; fulfilledOrCancelledHashes: string[] },
): Promise<void> {
  const SEL_CREATED = num.toHex(ORDER_CREATED_SELECTOR);
  const SEL_FULFILLED = num.toHex(ORDER_FULFILLED_SELECTOR);
  const SEL_CANCELLED = num.toHex(ORDER_CANCELLED_SELECTOR);
  const SEL_COUNTER = num.toHex(COUNTER_INCREMENTED_SELECTOR);

  const txCounters = new Map<string, number>();
  for (const rawEvent of events) {
    const selector = num.toHex(rawEvent.keys[0]);
    const evTxHash = rawEvent.transaction_hash ?? "";
    const logIndex = txCounters.get(evTxHash) ?? 0;
    txCounters.set(evTxHash, logIndex + 1);

    if (selector === SEL_CREATED) {
      const nftContract = await handleOrderCreated1155(rawEvent, tx, chain);
      if (nftContract) out.orderNftContracts.add(nftContract);
      continue;
    }

    if (selector === SEL_FULFILLED || selector === SEL_CANCELLED) {
      const orderHash = num.toHex(rawEvent.keys[1]);
      const offerer = normalizeAddress("STARKNET", rawEvent.keys[2]);
      const blockNumber = BigInt(rawEvent.block_number);

      if (selector === SEL_FULFILLED) {
        const parsedFill = parseRawOrderFulfilled1155(rawEvent, logIndex);
        const { isFinalFill } = await handleOrderFulfilled(parsedFill, tx, chain);
        if (isFinalFill) await cleanupGhostListings(orderHash, tx, chain);
      } else {
        await handleOrderCancelled(
          { type: "OrderCancelled", orderHash, offerer, blockNumber, txHash: evTxHash, logIndex },
          tx,
          chain,
        );
      }
      out.fulfilledOrCancelledHashes.push(orderHash);
      continue;
    }

    if (selector === SEL_COUNTER) {
      await handleCounterIncremented(
        {
          type: "CounterIncremented",
          offerer: normalizeAddress("STARKNET", rawEvent.keys[1]),
          newCounter: BigInt(rawEvent.data[0]).toString(),
          blockNumber: BigInt(rawEvent.block_number),
          txHash: evTxHash,
          logIndex,
        },
        tx,
        chain,
      );
    }
  }
}
