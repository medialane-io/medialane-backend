import { num } from "starknet";
import { ORDER_CREATED_SELECTOR, getTokenByAddress } from "../../../config/constants.js";
import { parseEvents } from "../../../mirror/parser.js";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

export const ORDER_CREATED_SELECTOR_HEX = num.toHex(ORDER_CREATED_SELECTOR);

export function isNftTransferEvent(
  event: ReturnType<typeof parseEvents>[number]
): event is ParsedTransfer | ParsedTransferSingle | ParsedTransferBatch {
  return (
    (event.type === "Transfer" || event.type === "TransferSingle" || event.type === "TransferBatch") &&
    !getTokenByAddress(event.contractAddress)
  );
}

export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // x-real-ip is set by Railway's edge and cannot be spoofed by the client.
  return c.req.header("x-real-ip")?.trim() ?? "unknown";
}
