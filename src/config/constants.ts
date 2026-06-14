import { hash } from "starknet";
import type { Chain } from "@prisma/client";
import { env } from "./env.js";

// Per-chain coordinates (spec 2026-06-13 §3.1). The backend reads several
// chains, so it keeps env-driven coordinates grouped per chain rather than a
// single chain-scoped SDK client. Only STARKNET is populated today; adding a
// chain adds an entry here. Each field prefers the chain-named env var and
// falls back to the legacy flat var so existing Railway env keeps working.
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
    marketplace721: env.STARKNET_MARKETPLACE_721 ?? env.MARKETPLACE_721_CONTRACT_MAINNET,
    marketplace1155: env.STARKNET_MARKETPLACE_1155 ?? env.MARKETPLACE_1155_CONTRACT_MAINNET,
    collection721: env.STARKNET_COLLECTION_721 ?? env.COLLECTION_721_CONTRACT_MAINNET,
    collection1155: env.STARKNET_COLLECTION_1155 ?? env.COLLECTION_1155_CONTRACT_MAINNET,
  },
};

export function chainCoords(chain: Chain): BackendChainCoords {
  const c = CHAIN_COORDS[chain];
  if (!c) throw new Error(`No coordinates configured for chain "${chain}"`);
  return c;
}

// Contract addresses — Starknet flat exports derive from the per-chain map so
// there is one source. The Starknet mirror/handlers use these names.
export const MARKETPLACE_721_CONTRACT = chainCoords("STARKNET").marketplace721;
export const MARKETPLACE_1155_CONTRACT = chainCoords("STARKNET").marketplace1155;
export const COLLECTION_721_CONTRACT = chainCoords("STARKNET").collection721;

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
export const CREATOR_COIN_FACTORY_CONTRACT = env.CREATOR_COIN_FACTORY_ADDRESS;
export const CREATOR_COIN_CREATED_SELECTOR = hash.getSelectorFromName("CreatorCoinCreated");
export const UNRUG_FACTORY_CONTRACT = env.UNRUG_FACTORY_ADDRESS;
export const COLLECTION_1155_CONTRACT = chainCoords("STARKNET").collection1155;
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
