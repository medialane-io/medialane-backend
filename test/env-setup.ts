process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.ALCHEMY_RPC_URL ??= "https://rpc.test.invalid/v0_8";
process.env.STARKNET_RPC_FALLBACK_URL ??= "https://rpc-fallback.test.invalid/v0_8";
process.env.HMAC_KEY ??= "test-hmac-key-must-be-at-least-32-characters-long";
process.env.SIWS_SECRET ??= "test-siws-secret-must-be-at-least-32-characters-long";
process.env.GUARDIAN_SECRET ??= "test-guardian-secret-must-be-at-least-32-characters";
