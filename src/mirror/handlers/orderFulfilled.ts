import { num } from "starknet";
import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedOrderFulfilled } from "../../types/marketplace.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { recordOrderFill } from "./orderFill.js";

const log = createLogger("handler:orderFulfilled");

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

      ...(event.remainingAmount !== undefined ? { remainingAmount } : {}),
    },
  });

  if (isFinalFill) {

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

export function parseRawOrderFulfilled1155(
  rawEvent: RawStarknetEvent,
  logIndex: number,
): ParsedOrderFulfilled {
  return {
    type: "OrderFulfilled",
    orderHash: num.toHex(rawEvent.keys[1]),
    offerer: normalizeAddress("STARKNET", rawEvent.keys[2]),
    fulfiller: normalizeAddress("STARKNET", rawEvent.keys[3]),
    blockNumber: BigInt(rawEvent.block_number),
    txHash: rawEvent.transaction_hash ?? "",
    logIndex,
    quantity: BigInt(rawEvent.data[0]).toString(),
    remainingAmount: BigInt(rawEvent.data[1]).toString(),
  };
}
