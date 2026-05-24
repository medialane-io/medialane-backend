// Schemas, sets, helpers shared across the intents route group.
// Keep this small — anything used by exactly one of build/lifecycle/settle
// belongs in that file.
import { z } from "zod";
import { num } from "starknet";
import { createLogger } from "../../../utils/logger.js";
import { ORDER_CREATED_SELECTOR, ORDER_FULFILLED_SELECTOR, getTokenByAddress } from "../../../config/constants.js";
import type { parseEvents } from "../../../mirror/parser.js";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

export const log = createLogger("routes:intents");

export const TTL_HOURS = 24;

export const starknetAddress = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet address");

export const listingSchema = z.object({
  offerer: starknetAddress,
  nftContract: starknetAddress,
  tokenId: z.string(),
  currency: z.string(),
  price: z.string(),
  endTime: z.number(),
  salt: z.string().optional(),
  /** ERC-1155 only: number of units to list. Omit for ERC-721. */
  amount: z.string().optional(),
});

export const offerSchema = listingSchema.extend({
  tokenStandard: z.enum(["ERC721", "ERC1155"]).optional(),
  quantity: z.string().optional(),
});

export const fulfillSchema = z.object({
  fulfiller: starknetAddress,
  orderHash: z.string(),
  tokenStandard: z.enum(["ERC721", "ERC1155"]).optional(),
  quantity: z.string().optional(),
});

export const cancelSchema = z.object({
  offerer: starknetAddress,
  orderHash: z.string(),
  tokenStandard: z.enum(["ERC721", "ERC1155"]).optional(),
});

export const mintSchema = z.object({
  owner: starknetAddress,
  collectionId: z.string().regex(/^\d+$/, "collectionId must be a non-negative integer string"),
  recipient: starknetAddress,
  tokenUri: z.string().min(1),
  collectionContract: starknetAddress.optional(),
});

export const createCollectionSchema = z.object({
  owner: starknetAddress,
  name: z.string().min(1),
  symbol: z.string().min(1),
  baseUri: z.string().default(""),
  description: z.string().optional(),
  image: z.string().optional(),
  collectionContract: starknetAddress.optional(),
});

export const counterOfferSchema = z.object({
  sellerAddress:     z.string().min(1),
  originalOrderHash: z.string().min(1),
  durationSeconds:   z.number().int().min(3600).max(2592000),
  priceRaw:          z.string().regex(/^\d+$/, "priceRaw must be a non-negative integer string"),
  message:           z.string().max(500).optional(),
});

export const checkoutBodySchema = z.object({
  fulfiller: z.string().min(1),
  orderHashes: z.array(z.string().min(1)).min(1).max(20),
});

export const confirmSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid transaction hash"),
});

export const signatureSchema = z.object({
  signature: z.array(z.string()).min(1, "signature array required"),
});

// Intent types that go through the marketplace contract and need event verification
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

export function isNftTransferEvent(
  event: ReturnType<typeof parseEvents>[number]
): event is ParsedTransfer | ParsedTransferSingle | ParsedTransferBatch {
  return (
    (event.type === "Transfer" || event.type === "TransferSingle" || event.type === "TransferBatch") &&
    !getTokenByAddress(event.contractAddress)
  );
}
