/**
 * Test preload (configured in bunfig.toml). Sets dummy values for the env vars
 * that `src/config/env.ts` validates at import time, so any test importing a
 * module that transitively loads env (logger, utils/starknet, db/client, …)
 * does not throw on import. Real env (from .env/.env.local) wins via `??=`.
 *
 * These are non-secret placeholders for import-time validation only — tests
 * that actually hit the DB / RPC still mock those layers.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.ALCHEMY_RPC_URL ??= "https://rpc.test.invalid/v0_8";
process.env.API_SECRET_KEY ??= "test-api-secret-key-0123456789";
process.env.PORTAL_SERVICE_SECRET ??= "test-portal-service-secret-0123456789";
process.env.HMAC_KEY ??= "test-hmac-key-must-be-at-least-32-characters-long";
process.env.SIWS_SECRET ??= "test-siws-secret-must-be-at-least-32-characters-long";
