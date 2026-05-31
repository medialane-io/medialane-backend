import { type Chain, type Prisma } from "@prisma/client";
import type { ParsedCounterIncremented } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:counterIncremented");

/**
 * Bulk cancel. The redesigned venues let a maker invalidate ALL their open
 * orders at once by bumping a per-offerer counter (orders are signed under a
 * specific counter and are only valid while it matches). The chain emits a
 * single `CounterIncremented` rather than per-order `OrderCancelled`, so the
 * indexer must mark the offerer's ACTIVE orders CANCELLED here or they would
 * keep showing as live while being unfulfillable on chain.
 */
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
