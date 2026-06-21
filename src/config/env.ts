import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  STARKNET_NETWORK: z.enum(["mainnet", "sepolia"]).default("mainnet"),
  ALCHEMY_RPC_URL: z.string().url(),
  STARKNET_RPC_FALLBACK_URL: z.string().url().optional(),
  // Chain-named coordinates (preferred — spec 2026-06-13 §3.1). The old
  // ALCHEMY_RPC_URL / *_MAINNET vars still read as fallbacks (below), so
  // existing Railway env keeps working until updated. Only Starknet is
  // populated today; other chains add their own group here when they land.
  // NOTE: ALCHEMY_RPC_URL stays the Starknet RPC fallback + capped circuit
  // breaker (feedback_alchemy_cap_is_intentional) — do not remove it.
  STARKNET_RPC_URL: z.string().url().optional(),
  STARKNET_MARKETPLACE_721: z.string().optional(),
  STARKNET_MARKETPLACE_1155: z.string().optional(),
  STARKNET_COLLECTION_721: z.string().optional(),
  STARKNET_COLLECTION_1155: z.string().optional(),
  // x402 agent payments (per-chain: settlement asset + treasury + MDLN bonus
  // token). Chain-prefixed for multichain readiness — a future Base rail adds
  // BASE_USDC_CONTRACT / BASE_X402_TREASURY without touching these.
  STARKNET_USDC_CONTRACT: z
    .string()
    .default("0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"),
  // Creator's Fund Starknet multisig (x402 USDC settles here — funds the Fund,
  // matching the platform fee→Creator's-Fund model). Override per env if needed.
  STARKNET_X402_TREASURY: z
    .string()
    .default("0x064c51746dbcb7498cc6e4b8abfcacd60805c0762b0411bb0515c611b5ae8223"),
  STARKNET_MDLN_CONTRACT: z.string().default(""),
  VOYAGER_API_KEY: z.string().default(""),
  CLERK_SECRET_KEY: z.string().default(""),
  MARKETPLACE_721_CONTRACT_MAINNET: z
    .string()
    .default("0x069cf5391077e3ebdd9cb6aebf90ed530d29f0d6aa34a43f5afae938c0fb565e"),
  MARKETPLACE_1155_CONTRACT_MAINNET: z
    .string()
    .default("0x040cd7b3e73bb3c892166e34bdc01d1797f97ecbc356c23f1cf38033cacf0077"),
  COLLECTION_721_CONTRACT_MAINNET: z
    .string()
    .default("0x0558c9b6ea4d403df6d765fb77be55702c572f0a811f037c6c4209fe1e5aeef2"), // MIP v0.4.0
  COMMENTS_CONTRACT_ADDRESS: z.string().default("0x024f97eb5abe659fb650bf162b5fc16501f8f3863a7369901ce6099462e62799"),
  COMMENTS_START_BLOCK: z.coerce.number().default(0),
  POP_FACTORY_ADDRESS: z.string().default(""),
  POP_START_BLOCK: z.coerce.number().default(0),
  DROP_FACTORY_ADDRESS: z.string().default(""),
  DROP_START_BLOCK: z.coerce.number().default(0),
  CREATOR_COIN_FACTORY_ADDRESS: z
    .string()
    .default("0x50fa807b5274079fb19374673d7bab6d2dc3af7e1032ea43eb6e44bcbde4c3c"),
  CREATOR_COIN_START_BLOCK: z.coerce.number().default(10474544),
  // Unruggable (unrug.top) memecoin factory — used to verify external coins via
  // is_memecoin() before adding them as external-erc20.
  UNRUG_FACTORY_ADDRESS: z
    .string()
    .default("0x01a46467a9246f45c8c340f1f155266a26a71c07bd55d36e8d1c7d0d438a2dbc"),
  // IP-Programmable-ERC1155 factory watched for CollectionDeployed. v0.3.0
  // (sequential on-chain edition ids) deployed mainnet 2026-06-10. The prior
  // v0.2.0 factory (0x067064…) is already fully indexed; existing collections'
  // token indexing is per-collection and unaffected by this switch.
  COLLECTION_1155_CONTRACT_MAINNET: z
    .string()
    .default("0x0083543c3ee15040a419fc539fa6889f5b956e7d071bcfa97842cb0ae42ad6cc"),
  INDEXER_START_BLOCK: z.coerce.number().default(9196722),
  CREATOR_COIN_POLL_INTERVAL_MS: z.coerce.number().default(50000),
  COLLECTION_721_START_BLOCK: z.coerce.number().default(11002817), // MIP v0.4.0 deploy block
  PINATA_JWT: z.string().default(""),
  PINATA_GATEWAY: z.string().default("gateway.pinata.cloud"),
  PORT: z.coerce.number().default(3000),
  API_SECRET_KEY: z.string().min(16),
  // Account-scoped service secret for the developer portal. Valid ONLY on
  // /admin/accounts/* (not the full admin surface) — so the portal never holds
  // the master API_SECRET_KEY. Optional: when unset, the portal falls back to
  // the master key (the account routes always accept the master too).
  PORTAL_SERVICE_SECRET: z.string().min(16).optional(),
  // API keys are hashed with HMAC-SHA256(key, HMAC_KEY) before storage and
  // lookup. Required — without it the backend cannot authenticate any key.
  // The legacy plain-SHA-256 fallback was removed 2026-05-24 after all
  // pre-HMAC keys were rotated (audit P2-4).
  HMAC_KEY: z.string().min(32, "HMAC_KEY must be at least 32 characters"),
  SIWS_SECRET: z.string().min(32),
  CORS_ORIGINS: z
    .string()
    .default("https://medialane.io,https://www.medialane.io,https://starknet.medialane.io,https://accounts.medialane.io,https://api.medialane.io,https://services.medialane.io,https://medialane.xyz,https://mediolano.app,http://localhost:3000,http://localhost:3001"),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(10000),
  INDEXER_BLOCK_BATCH_SIZE: z.coerce.number().default(500),
  TRANSFER_POLL_INTERVAL_MS: z.coerce.number().default(120_000),
  CHIPIPAY_API_KEY: z.string().default(""),
  CHIPIPAY_API_URL: z.string().default("https://api.chipi.io"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  REDIS_URL: z.string().url().optional(),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  CONTACT_FROM_EMAIL: z.string().default("Medialane <noreply@medialane.io>"),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();
export type Env = typeof env;
