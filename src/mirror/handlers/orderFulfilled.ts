import { num } from "starknet";
import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedOrderFulfilled } from "../../types/marketplace.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { recordOrderFill } from "./orderFill.js";

const log = createLogger("handler:orderFulfilled");

/**
 * Unified OrderFulfilled handler — works for both ERC-721 (always single-fill,
 * status flips to FULFILLED) and ERC-1155 (partial fills, status stays ACTIVE
 * until remainingAmount === "0").
 *
 * Returns `isFinalFill` so callers can gate per-final-fill side effects like
 * ghost-listing cleanup. For ERC-721 events, `quantity` defaults to "1" and
 * `remainingAmount` defaults to "0" — meaning every ERC-721 fulfillment is
 * final by definition.
 */
export async function handleOrderFulfilled(
  event: ParsedOrderFulfilled,
  tx: Prisma.TransactionClient,
  chain: Chain,
): Promise<{ isFinalFill: boolean }> {
  const quantity = event.quantity ?? "1";
  const remainingAmount = event.remainingAmount ?? "0";
  const isFinalFill = remainingAmount === "0";

  await recordOrderFill(
    {
      chain,
      orderHash: event.orderHash,
      fulfiller: event.fulfiller,
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      quantity,
      remainingAmount,
    },
    tx,
  );

  await tx.order.updateMany({
    where: { chain, orderHash: event.orderHash },
    data: {
      fulfiller: event.fulfiller,
      status: isFinalFill ? "FULFILLED" : "ACTIVE",
      fulfilledTxHash: isFinalFill ? event.txHash : undefined,
      // Only write remainingAmount for ERC-1155 (event carries it)
      ...(event.remainingAmount !== undefined ? { remainingAmount } : {}),
    },
  });

  if (isFinalFill) {
    // Complete any RemixOffer whose listing was just fully fulfilled.
    // Works for both standards now — previously only the ERC-721 path did this.
    const { count } = await tx.remixOffer.updateMany({
      where: { orderHash: event.orderHash, status: "APPROVED" },
      data: { status: "COMPLETED" },
    });
    if (count > 0) {
      log.info(
        { orderHash: event.orderHash, fulfiller: event.fulfiller },
        "RemixOffer completed via OrderFulfilled",
      );
    }
  }

  log.debug(
    { chain, orderHash: event.orderHash, fulfiller: event.fulfiller, remainingAmount, isFinalFill },
    isFinalFill ? "Order fully fulfilled" : "Order partially fulfilled",
  );

  return { isFinalFill };
}

/**
 * Parse an ERC-1155 OrderFulfilled raw event into ParsedOrderFulfilled shape.
 *
 * Event structure (Medialane1155 V2 — deployed 2026-04-28):
 *   keys[1] = order_hash       (felt252, indexed)
 *   keys[2] = offerer          (ContractAddress, indexed)
 *   keys[3] = fulfiller        (ContractAddress, indexed)
 *   data[0] = quantity         (felt252) - units bought in this fill
 *   data[1] = remaining_amount (felt252) - units still available
 *   data[2] = royalty_receiver (ContractAddress)
 *   data[3] = royalty_amount.low  (u256 low)
 *   data[4] = royalty_amount.high (u256 high)
 */
export function parseRawOrderFulfilled1155(
  rawEvent: RawStarknetEvent,
  logIndex: number,
): ParsedOrderFulfilled {
  return {
    type: "OrderFulfilled",
    orderHash: num.toHex(rawEvent.keys[1]),
    offerer: normalizeAddress(rawEvent.keys[2]),
    fulfiller: normalizeAddress(rawEvent.keys[3]),
    blockNumber: BigInt(rawEvent.block_number),
    txHash: rawEvent.transaction_hash ?? "",
    logIndex,
    quantity: BigInt(rawEvent.data[0]).toString(),
    remainingAmount: BigInt(rawEvent.data[1]).toString(),
  };
}
