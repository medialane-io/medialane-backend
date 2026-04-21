/**
 * Handle OrderFulfilled events from the Medialane1155 (ERC-1155 marketplace) contract.
 *
 * Unlike ERC-721 fulfillment, a single fill may be partial — the buyer picks a
 * quantity Q ≤ remaining_amount. The order stays ACTIVE until all units are sold.
 *
 * Event structure (v2 contract — deployed 2026-04-20):
 *   keys[1] = order_hash       (felt252, indexed)
 *   keys[2] = offerer          (ContractAddress, indexed)
 *   keys[3] = fulfiller        (ContractAddress, indexed)
 *   data[0] = quantity         (felt252) — units bought in this fill
 *   data[1] = remaining_amount (felt252) — units still available after this fill
 *   data[2] = royalty_receiver (ContractAddress)
 *   data[3] = royalty_amount.low  (u256 low)
 *   data[4] = royalty_amount.high (u256 high)
 */
import { num } from "starknet";
import type { Chain, Prisma } from "@prisma/client";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("handler:orderFulfilled1155");

export async function handleOrderFulfilled1155(
  rawEvent: RawStarknetEvent,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const orderHash   = normalizeAddress(rawEvent.keys[1]);
  const fulfiller   = normalizeAddress(rawEvent.keys[3]);
  const txHash      = rawEvent.transaction_hash ?? "";

  const remainingAmount = BigInt(rawEvent.data[1]).toString();
  const isFinalFill = remainingAmount === "0";

  await tx.order.updateMany({
    where: { chain, orderHash },
    data: {
      fulfiller,
      fulfilledTxHash: isFinalFill ? txHash : undefined,
      status: isFinalFill ? "FULFILLED" : "ACTIVE",
      remainingAmount,
    },
  });

  log.debug(
    { chain, orderHash, fulfiller, remainingAmount, isFinalFill },
    isFinalFill ? "ERC-1155 order fully fulfilled" : "ERC-1155 order partially fulfilled"
  );
}
