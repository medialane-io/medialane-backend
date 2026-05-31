import { hash } from "starknet";
import { env } from "./env.js";

// Contract addresses
export const MARKETPLACE_721_CONTRACT = env.MARKETPLACE_721_CONTRACT_MAINNET;
export const MARKETPLACE_1155_CONTRACT = env.MARKETPLACE_1155_CONTRACT_MAINNET;
export const COLLECTION_721_CONTRACT = env.COLLECTION_721_CONTRACT_MAINNET;

// Indexer starting block
export const START_BLOCK = env.INDEXER_START_BLOCK;
export const COLLECTION_721_START_BLOCK = env.COLLECTION_721_START_BLOCK;

// Event selectors (computed once at startup)
export const ORDER_CREATED_SELECTOR = hash.getSelectorFromName("OrderCreated");
export const ORDER_FULFILLED_SELECTOR =
  hash.getSelectorFromName("OrderFulfilled");
export const ORDER_CANCELLED_SELECTOR =
  hash.getSelectorFromName("OrderCancelled");
export const COUNTER_INCREMENTED_SELECTOR =
  hash.getSelectorFromName("CounterIncremented");
export const TRANSFER_SELECTOR = hash.getSelectorFromName("Transfer");
// ERC-1155 transfer event selectors
export const TRANSFER_SINGLE_SELECTOR = hash.getSelectorFromName("TransferSingle");
export const TRANSFER_BATCH_SELECTOR = hash.getSelectorFromName("TransferBatch");
export const COLLECTION_CREATED_SELECTOR = hash.getSelectorFromName("CollectionCreated");
export const COMMENTS_CONTRACT = env.COMMENTS_CONTRACT_ADDRESS;
export const COMMENT_ADDED_SELECTOR = hash.getSelectorFromName("CommentAdded");
export const POP_FACTORY_CONTRACT = env.POP_FACTORY_ADDRESS;
export const POP_ALLOWLIST_UPDATED_SELECTOR = hash.getSelectorFromName("AllowlistUpdated");
export const DROP_FACTORY_CONTRACT = env.DROP_FACTORY_ADDRESS;
export const DROP_CREATED_SELECTOR = hash.getSelectorFromName("DropCreated");
export const COLLECTION_1155_CONTRACT = env.COLLECTION_1155_CONTRACT_MAINNET;
export const COLLECTION_DEPLOYED_SELECTOR = hash.getSelectorFromName("CollectionDeployed");

// Token catalogue + lookup come from @medialane/sdk (single source of truth).
// Re-exported here so internal callers keep their existing import path.
export {
  SUPPORTED_TOKENS,
  getTokenByAddress,
  type SupportedToken,
} from "@medialane/sdk";

// IPFS gateways (in priority order)
export const IPFS_GATEWAYS = [
  `https://${env.PINATA_GATEWAY}/ipfs`,
  "https://cloudflare-ipfs.com/ipfs",
  "https://ipfs.io/ipfs",
];

// Chain IDs
export const CHAIN_IDS = {
  mainnet:
    "0x534e5f4d41494e" as const, // SN_MAIN
  sepolia: "0x534e5f5345504f4c4941" as const, // SN_SEPOLIA
};

export function getChainId(): string {
  return env.STARKNET_NETWORK === "mainnet"
    ? CHAIN_IDS.mainnet
    : CHAIN_IDS.sepolia;
}

// Zero address
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
