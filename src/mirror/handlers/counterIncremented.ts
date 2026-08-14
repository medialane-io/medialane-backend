import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedCounterIncremented } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:counterIncremented");

export async function handleCounterIncremented(
  event: ParsedCounterIncremented,
  tx: Prisma.TransactionClient,
  chain: Chain,
): Promise<void> {
  const { count } = await tx.order.updateMany({
    where: { chain, offerer: event.offerer, status: "ACTIVE" },
    data: { status: "CANCELLED", cancelledTxHash: event.txHash },
  });
  if (count > 0) {
    log.info(
      { chain, offerer: event.offerer, count, newCounter: event.newCounter },
      "Bulk-cancel via CounterIncremented",
    );
  }
}
