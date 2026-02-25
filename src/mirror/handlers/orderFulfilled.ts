import { type Prisma } from "@prisma/client";
import type { ParsedOrderFulfilled } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:orderFulfilled");

export async function handleOrderFulfilled(
  event: ParsedOrderFulfilled,
  tx: Prisma.TransactionClient
): Promise<void> {
  await tx.order.updateMany({
    where: { orderHash: event.orderHash },
    data: {
      status: "FULFILLED",
      fulfiller: event.fulfiller,
      fulfilledTxHash: event.txHash,
    },
  });

  log.debug(
    { orderHash: event.orderHash, fulfiller: event.fulfiller },
    "Order fulfilled"
  );
}
