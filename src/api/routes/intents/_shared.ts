

import { num } from "starknet";
import { createLogger } from "../../../utils/logger.js";
import {
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  getTokenByAddress,
} from "../../../config/constants.js";
import type { parseEvents } from "../../../mirror/parser.js";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

export const log = createLogger("routes:intents");

export const TTL_HOURS = 24;

export interface CheckoutItemInput {
  orderHash: string;
  quantity: string | undefined;
}

export function normalizeCheckoutItems(body: {
  orderHashes?: string[];
  items?: { orderHash: string; quantity?: string }[];
}): CheckoutItemInput[] {
  if (body.items?.length) {
    return body.items.map((i) => ({ orderHash: i.orderHash, quantity: i.quantity }));
  }
  return (body.orderHashes ?? []).map((orderHash) => ({ orderHash, quantity: undefined }));
}

export const MARKETPLACE_INTENT_TYPES = new Set([
  "CREATE_LISTING",
  "MAKE_OFFER",
  "FULFILL_ORDER",
  "CANCEL_ORDER",
  "COUNTER_OFFER",
]);
export const RECEIPT_HYDRATED_INTENT_TYPES = new Set([
  "MINT",
]);
export const ORDER_CREATING_INTENT_TYPES = new Set([
  "CREATE_LISTING",
  "MAKE_OFFER",
  "COUNTER_OFFER",
]);
export const ORDER_CREATED_SELECTOR_HEX = num.toHex(ORDER_CREATED_SELECTOR);
export const ORDER_FULFILLED_SELECTOR_HEX = num.toHex(ORDER_FULFILLED_SELECTOR);
export const ORDER_CANCELLED_SELECTOR_HEX = num.toHex(ORDER_CANCELLED_SELECTOR);

export function isNftTransferEvent(
  event: ReturnType<typeof parseEvents>[number]
): event is ParsedTransfer | ParsedTransferSingle | ParsedTransferBatch {
  return (
    (event.type === "Transfer" || event.type === "TransferSingle" || event.type === "TransferBatch") &&
    !getTokenByAddress(event.contractAddress)
  );
}
