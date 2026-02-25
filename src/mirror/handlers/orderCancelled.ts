import { type Prisma } from "@prisma/client";
import type { ParsedOrderCancelled } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:orderCancelled");

export async function handleOrderCancelled(
  event: ParsedOrderCancelled,
  tx: Prisma.TransactionClient
): Promise<void> {
  await tx.order.updateMany({
    where: { orderHash: event.orderHash },
    data: {
      status: "CANCELLED",
      cancelledTxHash: event.txHash,
    },
  });

  log.debug({ orderHash: event.orderHash }, "Order cancelled");
}
