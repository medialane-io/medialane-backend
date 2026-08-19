import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  ALCHEMY_RPC_URL: z.string().url(),

  ETHEREUM_RPC_URL: z.string().url().optional(),
  BASE_RPC_URL: z.string().url().optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  STELLAR_RPC_URL: z.string().url().optional(),
  STARKNET_RPC_FALLBACK_URL: z.string().url().optional(),

  STARKNET_RPC_URL: z.string().url().optional(),

  ALCHEMY_PRICES_KEY: z.string().default(""),

  STARKNET_USDC_CONTRACT: z
    .string()
    .default("0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"),

  STARKNET_X402_TREASURY: z
    .string()
    .default("0x064c51746dbcb7498cc6e4b8abfcacd60805c0762b0411bb0515c611b5ae8223"),
  STARKNET_MDLN_CONTRACT: z.string().default(""),
  VOYAGER_API_KEY: z.string().default(""),

  COMMENTS_START_BLOCK: z.coerce.number().default(0),
  POP_START_BLOCK: z.coerce.number().default(0),
  DROP_START_BLOCK: z.coerce.number().default(0),
  CREATOR_COIN_START_BLOCK: z.coerce.number().default(10474544),

  UNRUG_FACTORY_ADDRESS: z
    .string()
    .default("0x01a46467a9246f45c8c340f1f155266a26a71c07bd55d36e8d1c7d0d438a2dbc"),
  INDEXER_START_BLOCK: z.coerce.number().default(9196722),
  CREATOR_COIN_POLL_INTERVAL_MS: z.coerce.number().default(300000),

  LAUNCHPAD_POLL_INTERVAL_MS: z.coerce.number().default(300000),
  PINATA_JWT: z.string().default(""),
  PINATA_GATEWAY: z.string().default("gateway.pinata.cloud"),
  PINATA_GATEWAY_TOKEN: z.string().default(""),
  PORT: z.coerce.number().default(3000),

  HMAC_KEY: z.string().min(32, "HMAC_KEY must be at least 32 characters"),
  SIWS_SECRET: z.string().min(32),
  CORS_ORIGINS: z
    .string()
    .default("https://medialane.io,https://www.medialane.io,https://starknet.medialane.io,https://accounts.medialane.io,https://api.medialane.io,https://services.medialane.io,https://medialane.xyz,https://mediolano.app,http://localhost:3000,http://localhost:3001"),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(30000),
  INDEXER_BLOCK_BATCH_SIZE: z.coerce.number().default(500),

  INDEXER_CONFIRMATION_BLOCKS: z.coerce.number().min(0).default(2),
  TRANSFER_POLL_INTERVAL_MS: z.coerce.number().default(300_000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  REDIS_URL: z.string().url().optional(),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  CONTACT_FROM_EMAIL: z.string().default("Medialane <noreply@medialane.io>"),
  MAIL_RELAY_URL: z.string().default(""),
  MAIL_RELAY_SECRET: z.string().default(""),
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
