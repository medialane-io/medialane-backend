import { hash } from "starknet";
import { env } from "./env.js";

// Contract addresses
export const MARKETPLACE_CONTRACT = env.MARKETPLACE_CONTRACT_MAINNET;
export const COLLECTION_CONTRACT = env.COLLECTION_CONTRACT_MAINNET;

// Indexer starting block
export const START_BLOCK = env.INDEXER_START_BLOCK;

// Event selectors (computed once at startup)
export const ORDER_CREATED_SELECTOR = hash.getSelectorFromName("OrderCreated");
export const ORDER_FULFILLED_SELECTOR =
  hash.getSelectorFromName("OrderFulfilled");
export const ORDER_CANCELLED_SELECTOR =
  hash.getSelectorFromName("OrderCancelled");
export const TRANSFER_SELECTOR = hash.getSelectorFromName("Transfer");

// Token map (address → metadata)
export const SUPPORTED_TOKENS = [
  {
    symbol: "USDC",
    address:
      "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
    decimals: 6,
  },
  {
    symbol: "USDT",
    address:
      "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8",
    decimals: 6,
  },
  {
    symbol: "ETH",
    address:
      "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    decimals: 18,
  },
  {
    symbol: "STRK",
    address:
      "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    decimals: 18,
  },
] as const;

export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

export function getTokenByAddress(address: string): SupportedToken | undefined {
  const normalized = address.toLowerCase();
  return SUPPORTED_TOKENS.find((t) => t.address.toLowerCase() === normalized);
}

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
