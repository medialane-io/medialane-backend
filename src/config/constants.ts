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
  STARKNET_COLLECTION_721_START_BLOCK,
} from "@medialane/sdk";
import { env } from "./env.js";

// Per-chain coordinates. Contract addresses come from the SDK's chain-named
// constants (single source — no env overrides); only the RPC URL is env. Only
// STARKNET today; another chain adds an entry from its SDK constants.
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

// Contract addresses — the SDK's chain-named constants, re-exported so callers
// import them from here. Single source; no local short aliases.
export {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_COLLECTION_1155_CONTRACT,
  STARKNET_NFTCOMMENTS_CONTRACT,
  STARKNET_POP_FACTORY_CONTRACT,
  STARKNET_DROP_FACTORY_CONTRACT,
  STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
};

// Indexer starting block
export const START_BLOCK = env.INDEXER_START_BLOCK;
// Chain-named, single-sourced from the SDK (`chains.ts`) — no env var. The
// registry's deploy block is a Starknet fact, so it carries the chain prefix.
export const COLLECTION_721_START_BLOCK = STARKNET_COLLECTION_721_START_BLOCK;

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
export const COMMENT_ADDED_SELECTOR = hash.getSelectorFromName("CommentAdded");
export const POP_ALLOWLIST_UPDATED_SELECTOR = hash.getSelectorFromName("AllowlistUpdated");
export const DROP_CREATED_SELECTOR = hash.getSelectorFromName("DropCreated");
export const CREATOR_COIN_CREATED_SELECTOR = hash.getSelectorFromName("CreatorCoinCreated");
// Unrug.top memecoin factory — external (not a Medialane contract), so it stays env.
export const UNRUG_FACTORY_CONTRACT = env.UNRUG_FACTORY_ADDRESS;
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

// Chain IDs. Medialane is mainnet-only (no network/Sepolia axis).
export const CHAIN_IDS = {
  mainnet: "0x534e5f4d41494e" as const, // SN_MAIN
};

export function getChainId(): string {
  return CHAIN_IDS.mainnet;
}

// Zero address
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
