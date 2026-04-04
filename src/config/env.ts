import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  STARKNET_NETWORK: z.enum(["mainnet", "sepolia"]).default("mainnet"),
  ALCHEMY_RPC_URL: z.string().url(),
  STARKNET_RPC_FALLBACK_URL: z.string().url().optional(),
  VOYAGER_API_KEY: z.string().default(""),
  MARKETPLACE_CONTRACT_MAINNET: z
    .string()
    .default("0x04299b51289aa700de4ce19cc77bcea8430bfd1aef04193efab09d60a3a7ee0f"),
  COLLECTION_CONTRACT_MAINNET: z
    .string()
    .default("0x05e73b7be06d82beeb390a0e0d655f2c9e7cf519658e04f05d9c690ccc41da03"),
  COMMENTS_CONTRACT_ADDRESS: z.string().default(""),
  COMMENTS_START_BLOCK: z.coerce.number().default(0),
  POP_FACTORY_ADDRESS: z.string().default(""),
  POP_START_BLOCK: z.coerce.number().default(0),
  DROP_FACTORY_ADDRESS: z.string().default(""),
  DROP_START_BLOCK: z.coerce.number().default(0),
  INDEXER_START_BLOCK: z.coerce.number().default(6204232),
  PINATA_JWT: z.string().default(""),
  PINATA_GATEWAY: z.string().default("gateway.pinata.cloud"),
  PORT: z.coerce.number().default(3000),
  API_SECRET_KEY: z.string().min(16),
  // When set, new API keys are hashed with HMAC-SHA256(key, HMAC_KEY) instead of
  // plain SHA-256. Existing keys stored as plain SHA-256 continue to work (dual-lookup).
  HMAC_KEY: z.string().default(""),
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
