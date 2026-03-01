import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  STARKNET_NETWORK: z.enum(["mainnet", "sepolia"]).default("mainnet"),
  ALCHEMY_RPC_URL: z.string().url(),
  VOYAGER_API_KEY: z.string().default(""),
  MARKETPLACE_CONTRACT_MAINNET: z
    .string()
    .default("0x059deafbbafbf7051c315cf75a94b03c5547892bc0c6dfa36d7ac7290d4cc33a"),
  COLLECTION_CONTRACT_MAINNET: z
    .string()
    .default("0x05e73b7be06d82beeb390a0e0d655f2c9e7cf519658e04f05d9c690ccc41da03"),
  INDEXER_START_BLOCK: z.coerce.number().default(6204232),
  PINATA_JWT: z.string().default(""),
  PINATA_GATEWAY: z.string().default("gateway.pinata.cloud"),
  PORT: z.coerce.number().default(3000),
  API_SECRET_KEY: z.string().min(16),
  CORS_ORIGINS: z
    .string()
    .default("https://medialane.xyz,https://mediolano.app,http://localhost:3000"),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(6000),
  INDEXER_BLOCK_BATCH_SIZE: z.coerce.number().default(500),
  CHIPIPAY_API_KEY: z.string().default(""),
  CHIPIPAY_API_URL: z.string().default("https://api.chipi.io"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
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
