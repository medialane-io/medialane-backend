import type { OnChainOrderDetails } from "../../types/marketplace.js";

/**
 * Reject an empty/all-zero result from `get_order_details`. When the RPC node
 * serving the read lags behind the OrderCreated event's block, the contract
 * returns a zero struct (offerer `0x0`, item_type `""`) with no error.
 * Persisting that produced "zombie" listings with null nftContract/nftTokenId
 * that never surface and render as `/asset/null/null` (the 2026-06-08 incident,
 * where a valid ERC-1155 listing read empty off a lagging node).
 *
 * Throwing here lets `withRetry`'s backoff give the node time to catch up (and
 * rotate endpoints). If it stays empty across all attempts the handler returns
 * `null` — the order is left for a later `/admin/orders/:hash/resync` instead of
 * being stored corrupt.
 *
 * Pure + dependency-free (no env-validating imports) so it stays unit-testable.
 */
export function assertOrderPopulated(d: OnChainOrderDetails, orderHash: string): void {
  if (BigInt(d.offerer) === 0n || d.offerItemType === "") {
    throw new Error(
      `get_order_details returned an empty order for ${orderHash} — RPC node likely behind the event block; retrying`,
    );
  }
}
