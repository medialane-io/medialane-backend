// Schemas, sets, helpers shared across the intents route group.
// Keep this small — anything used by exactly one of build/lifecycle/settle
// belongs in that file.
import { z } from "zod";
import { num } from "starknet";
import { createLogger } from "../../../utils/logger.js";
import { ORDER_CREATED_SELECTOR, ORDER_FULFILLED_SELECTOR, getTokenByAddress } from "../../../config/constants.js";
import { FACTORY_FAMILY_SERVICE_IDS, TIER_SERVICE_IDS } from "../../../orchestrator/intent.js";
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
  recipient: starknetAddress,
  // Registry mint (mip-erc721/ip-erc721, the default): collectionId + tokenUri required.
  collectionId: z.string().regex(/^\d+$/, "collectionId must be a non-negative integer string").optional(),
  tokenUri: z.string().min(1).optional(),
  // EIP-2981 royalty (bps, 0–10_000), receiver = creator. Registry mint only. Optional for
  // back-compat with pre-v0.4.0 app bundles (defaults to 0); the app caps input at 50% (5000).
  royaltyBps: z.number().int().min(0).max(10000).optional().default(0),
  // Per-creator-factory mint (mip-erc1155/ip-tickets/ip-club, resolved from collectionContract):
  // mip-erc1155 needs tokenUri (above) + value; ip-tickets/ip-club need an existing tokenId + amount.
  tokenId: z.string().regex(/^\d+$/, "tokenId must be a non-negative integer string").optional(),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string").optional(),
  value: z.string().regex(/^\d+$/, "value must be a non-negative integer string").optional(),
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
  // Omitted (default): registry entry for mip-erc721/ip-erc721. One of these
  // deploys a new per-creator contract via that service's factory instead.
  service: z.enum(FACTORY_FAMILY_SERVICE_IDS).optional(),
});

export const createTierSchema = z.object({
  owner: starknetAddress,
  collection: starknetAddress,
  service: z.enum(TIER_SERVICE_IDS),
  maxSupply: z.string().regex(/^\d+$/, "maxSupply must be a non-negative integer string"),
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
  royaltyBps: z.number().int().min(0).max(10000).default(0),
  metadataUri: z.string().min(1),
});

// ── IP-Sponsorship schemas ───────────────────────────────────────────────────

export const sponsorshipOfferSchema = z.object({
  author: starknetAddress,
  nftContract: starknetAddress,
  tokenId: z.string(),
  minAmount: z.string().regex(/^\d+$/, "minAmount must be a non-negative integer string"),
  duration: z.number().int().positive(),
  paymentToken: starknetAddress,
  licenseTermsUri: z.string().min(1),
  transferable: z.boolean(),
  royaltyBps: z.number().int().min(0).max(10000).default(0),
  specificSponsor: starknetAddress.optional(),
});

export const sponsorshipOfferOpenSchema = z.object({
  author: starknetAddress,
  offerId: z.string(),
  open: z.boolean(),
});

export const sponsorshipBidSchema = z.object({
  sponsor: starknetAddress,
  offerId: z.string(),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  paymentToken: starknetAddress,
});

export const sponsorshipBidRetractSchema = z.object({
  sponsor: starknetAddress,
  offerId: z.string(),
});

export const sponsorshipBidAcceptSchema = z.object({
  author: starknetAddress,
  offerId: z.string(),
  sponsor: starknetAddress,
});

export const sponsorshipProposalSchema = z.object({
  proposer: starknetAddress,
  nftContract: starknetAddress,
  tokenId: z.string(),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  duration: z.number().int().positive(),
  validUntil: z.number().int().nonnegative().optional(),
  paymentToken: starknetAddress,
  licenseTermsUri: z.string().min(1),
  transferable: z.boolean(),
  royaltyBps: z.number().int().min(0).max(10000).default(0),
});

export const sponsorshipProposalWithdrawSchema = z.object({
  proposer: starknetAddress,
  proposalId: z.string(),
});

export const sponsorshipProposalAcceptSchema = z.object({
  owner: starknetAddress,
  proposalId: z.string(),
});

export const sponsorshipProposalRejectSchema = z.object({
  owner: starknetAddress,
  proposalId: z.string(),
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
