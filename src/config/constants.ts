import { hash } from "starknet";
import type { Chain } from "@prisma/client";
import {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_COLLECTION_1155_CONTRACT,
  STARKNET_NFTCOMMENTS_CONTRACT,
  STARKNET_POP_FACTORY_CONTRACT,
  STARKNET_DROP_FACTORY_CONTRACT,
  STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
  STARKNET_IP_TICKETS_FACTORY_CONTRACT,
  STARKNET_IP_CLUB_FACTORY_CONTRACT,
  STARKNET_IP_SPONSORSHIP_CONTRACT,
  STARKNET_COLLECTION_721_START_BLOCK,
} from "@medialane/sdk";
import { env } from "./env.js";

interface BackendChainCoords {
  rpcUrl: string;
  marketplace721: string;
  marketplace1155: string;
  collection721: string;
  collection1155: string;
}

export const CHAIN_COORDS: Partial<Record<Chain, BackendChainCoords>> = {
  STARKNET: {
    rpcUrl: env.STARKNET_RPC_URL ?? env.ALCHEMY_RPC_URL,
    marketplace721: STARKNET_MARKETPLACE_721_CONTRACT,
    marketplace1155: STARKNET_MARKETPLACE_1155_CONTRACT,
    collection721: STARKNET_COLLECTION_721_CONTRACT,
    collection1155: STARKNET_COLLECTION_1155_CONTRACT,
  },
};

export function chainCoords(chain: Chain): BackendChainCoords {
  const c = CHAIN_COORDS[chain];
  if (!c) throw new Error(`No coordinates configured for chain "${chain}"`);
  return c;
}

export {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
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

export const COLLECTION_721_START_BLOCK = STARKNET_COLLECTION_721_START_BLOCK;

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
export const POP_ALLOWLIST_UPDATED_SELECTOR = hash.getSelectorFromName("AllowlistUpdated");
export const DROP_CREATED_SELECTOR = hash.getSelectorFromName("DropCreated");
export const CLAIM_CONDITIONS_UPDATED_SELECTOR = hash.getSelectorFromName("ClaimConditionsUpdated");
export const CREATOR_COIN_CREATED_SELECTOR = hash.getSelectorFromName("CreatorCoinCreated");

export const UNRUG_FACTORY_CONTRACT = env.UNRUG_FACTORY_ADDRESS;
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
  "https://ipfs.io/ipfs",
  `https://${env.PINATA_GATEWAY}/ipfs`,
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
