import type { OnChainOrderDetails } from "../../types/marketplace.js";

export function assertOrderPopulated(d: OnChainOrderDetails, orderHash: string): void {
  if (BigInt(d.offerer) === 0n || d.offerItemType === "") {
    throw new Error(
      `get_order_details returned an empty order for ${orderHash} — RPC node likely behind the event block; retrying`,
    );
  }
}
