import { randomBytes, createHmac } from "crypto";
import { env } from "../config/env.js";

/**
 * Generate a new API key.
 * Returns the plaintext key (shown once, never stored), its 12-char prefix
 * (stored for display), and the hash (stored for lookup).
 *
 * Always HMAC-SHA256(plaintext, HMAC_KEY) — prevents offline brute-force
 * if the keyHash column ever leaks. Pre-HMAC plain-SHA-256 keys (the
 * dual-lookup path that existed until 2026-05-24) have been rotated; the
 * fallback is gone. See medialane-core/docs/plans/2026-05-24-apikey-per-app-rotation.md.
 */
export function generateApiKey(): {
  plaintext: string;
  prefix: string;
  keyHash: string;
} {
  const raw = randomBytes(32).toString("hex"); // 64 hex chars
  const plaintext = `ml_live_${raw}`;
  const prefix = plaintext.slice(0, 12); // "ml_live_a1b2"
  const keyHash = hashApiKey(plaintext);
  return { plaintext, prefix, keyHash };
}

/** HMAC-SHA256 hash of an API key for storage / lookup. */
export function hashApiKey(plaintext: string): string {
  return createHmac("sha256", env.HMAC_KEY).update(plaintext).digest("hex");
}
