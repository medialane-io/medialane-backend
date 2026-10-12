import { hash } from "starknet";
import type { Chain } from "@prisma/client";
import {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_DATA_TOKENIZATION_721_CONTRACT,
  STARKNET_COLLECTION_1155_CONTRACT,
  STARKNET_NFTCOMMENTS_CONTRACT,
  STARKNET_POP_FACTORY_CONTRACT,
  STARKNET_DROP_FACTORY_CONTRACT,
  STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
  STARKNET_IP_TICKETS_FACTORY_CONTRACT,
  STARKNET_IP_CLUB_FACTORY_CONTRACT,
  STARKNET_IP_SPONSORSHIP_CONTRACT,
  STARKNET_POP_FACTORY_START_BLOCK,
  STARKNET_DROP_FACTORY_START_BLOCK,
} from "@medialane/sdk";
import { env } from "./env.js";

export {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_DATA_TOKENIZATION_721_CONTRACT,
  STARKNET_COLLECTION_1155_CONTRACT,
  STARKNET_NFTCOMMENTS_CONTRACT,
  STARKNET_POP_FACTORY_CONTRACT,
  STARKNET_DROP_FACTORY_CONTRACT,
  STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
  STARKNET_IP_TICKETS_FACTORY_CONTRACT,
  STARKNET_IP_CLUB_FACTORY_CONTRACT,
  STARKNET_IP_SPONSORSHIP_CONTRACT,
};

export const START_BLOCK = env.INDEXER_START_BLOCK;

export const POP_FACTORY_START_BLOCK = STARKNET_POP_FACTORY_START_BLOCK;
export const DROP_FACTORY_START_BLOCK = STARKNET_DROP_FACTORY_START_BLOCK;

export const ORDER_CREATED_SELECTOR = hash.getSelectorFromName("OrderCreated");
export const ORDER_FULFILLED_SELECTOR =
  hash.getSelectorFromName("OrderFulfilled");
export const ORDER_CANCELLED_SELECTOR =
  hash.getSelectorFromName("OrderCancelled");
export const COUNTER_INCREMENTED_SELECTOR =
  hash.getSelectorFromName("CounterIncremented");
export const TRANSFER_SELECTOR = hash.getSelectorFromName("Transfer");

export const TRANSFER_SINGLE_SELECTOR = hash.getSelectorFromName("TransferSingle");
export const TRANSFER_BATCH_SELECTOR = hash.getSelectorFromName("TransferBatch");
export const COLLECTION_CREATED_SELECTOR = hash.getSelectorFromName("CollectionCreated");
export const COMMENT_ADDED_SELECTOR = hash.getSelectorFromName("CommentAdded");
export const DROP_CREATED_SELECTOR = hash.getSelectorFromName("DropCreated");
export const DROP_CLAIMED_SELECTOR = hash.getSelectorFromName("Claimed");
export const DROP_ISSUED_SELECTOR = hash.getSelectorFromName("Issued");
export const DROP_ALLOWLIST_ROOT_SET_SELECTOR = hash.getSelectorFromName("AllowlistRootSet");
export const DROP_COLLECTION_SELECTORS = [DROP_CLAIMED_SELECTOR, DROP_ISSUED_SELECTOR, DROP_ALLOWLIST_ROOT_SET_SELECTOR];
export const CREATOR_COIN_CREATED_SELECTOR = hash.getSelectorFromName("CreatorCoinCreated");

export const COLLECTION_DEPLOYED_SELECTOR = hash.getSelectorFromName("CollectionDeployed");
export const CLUB_DEPLOYED_SELECTOR = hash.getSelectorFromName("ClubDeployed");

export const OFFER_CREATED_SELECTOR = hash.getSelectorFromName("OfferCreated");
export const OFFER_STATUS_UPDATED_SELECTOR = hash.getSelectorFromName("OfferStatusUpdated");
export const BID_PLACED_SELECTOR = hash.getSelectorFromName("BidPlaced");
export const BID_RETRACTED_SELECTOR = hash.getSelectorFromName("BidRetracted");
export const SPONSORSHIP_ACCEPTED_SELECTOR = hash.getSelectorFromName("SponsorshipAccepted");
export const PROPOSAL_CREATED_SELECTOR = hash.getSelectorFromName("ProposalCreated");
export const PROPOSAL_CLOSED_SELECTOR = hash.getSelectorFromName("ProposalClosed");
export const PROPOSAL_ACCEPTED_SELECTOR = hash.getSelectorFromName("ProposalAccepted");
export const LICENSE_MINTED_SELECTOR = hash.getSelectorFromName("LicenseMinted");

export {
  SUPPORTED_TOKENS,
  getTokenByAddress,
  type SupportedToken,
} from "@medialane/sdk";

export const ACCOUNT_CREATED_GUID_SELECTOR = hash.getSelectorFromName("AccountCreatedGuid");
export const GUARDIAN_ADDED_GUID_SELECTOR = hash.getSelectorFromName("GuardianAddedGuid");
export const ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR = hash.getSelectorFromName("EscapeOwnerTriggeredGuid");
export const OWNER_ESCAPED_GUID_SELECTOR = hash.getSelectorFromName("OwnerEscapedGuid");
export const ESCAPE_CANCELED_SELECTOR = hash.getSelectorFromName("EscapeCanceled");

export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs",
  "https://ipfs.io/ipfs",
  "https://dweb.link/ipfs",
];

export const CHAIN_IDS = {
  mainnet: "0x534e5f4d41494e" as const,
};

export function getChainId(): string {
  return CHAIN_IDS.mainnet;
}

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
