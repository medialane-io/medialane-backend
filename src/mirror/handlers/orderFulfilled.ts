import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedOrderFulfilled } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:orderFulfilled");

export async function handleOrderFulfilled(
  event: ParsedOrderFulfilled,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  await tx.order.updateMany({
    where: { chain, orderHash: event.orderHash },
    data: {
      status: "FULFILLED",
      fulfiller: event.fulfiller,
      fulfilledTxHash: event.txHash,
    },
  });

  log.debug(
    { chain, orderHash: event.orderHash, fulfiller: event.fulfiller },
    "Order fulfilled"
  );
}
