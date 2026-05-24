import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  STARKNET_NETWORK: z.enum(["mainnet", "sepolia"]).default("mainnet"),
  ALCHEMY_RPC_URL: z.string().url(),
  STARKNET_RPC_FALLBACK_URL: z.string().url().optional(),
  VOYAGER_API_KEY: z.string().default(""),
  CLERK_SECRET_KEY: z.string().default(""),
  MARKETPLACE_721_CONTRACT_MAINNET: z
    .string()
    .default("0x00f8ccaae0bc811c79605974cc1dab769b9cea8877f033f8e3c17f30457caba6"),
  MARKETPLACE_1155_CONTRACT_MAINNET: z
    .string()
    .default("0x02bfa521c25461a09d735889b469418608d7d92f8b26e3d37ef174a4c2e22f99"),
  COLLECTION_721_CONTRACT_MAINNET: z
    .string()
    .default("0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2"),
  COMMENTS_CONTRACT_ADDRESS: z.string().default("0x024f97eb5abe659fb650bf162b5fc16501f8f3863a7369901ce6099462e62799"),
  COMMENTS_START_BLOCK: z.coerce.number().default(0),
  POP_FACTORY_ADDRESS: z.string().default(""),
  POP_START_BLOCK: z.coerce.number().default(0),
  DROP_FACTORY_ADDRESS: z.string().default(""),
  DROP_START_BLOCK: z.coerce.number().default(0),
  COLLECTION_1155_CONTRACT_MAINNET: z
    .string()
    .default("0x067064adcaaed61e17bf50ea802ea6482336126aec5b4d032b4ff8fbb5009131"),
  INDEXER_START_BLOCK: z.coerce.number().default(9196722),
  COLLECTION_721_START_BLOCK: z.coerce.number().default(10046166),
  PINATA_JWT: z.string().default(""),
  PINATA_GATEWAY: z.string().default("gateway.pinata.cloud"),
  PORT: z.coerce.number().default(3000),
  API_SECRET_KEY: z.string().min(16),
  // API keys are hashed with HMAC-SHA256(key, HMAC_KEY) before storage and
  // lookup. Required — without it the backend cannot authenticate any key.
  // The legacy plain-SHA-256 fallback was removed 2026-05-24 after all
  // pre-HMAC keys were rotated (audit P2-4).
  HMAC_KEY: z.string().min(32, "HMAC_KEY must be at least 32 characters"),
  SIWS_SECRET: z.string().min(32),
  CORS_ORIGINS: z
    .string()
    .default("https://medialane.io,https://www.medialane.io,https://dapp.medialane.io,https://accounts.medialane.io,https://api.medialane.io,https://services.medialane.io,https://medialane.xyz,https://mediolano.app,http://localhost:3000,http://localhost:3001"),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(6000),
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
