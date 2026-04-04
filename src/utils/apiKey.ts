import { randomBytes, createHash, createHmac } from "crypto";
import { env } from "../config/env.js";

/**
 * Generate a new API key.
 * Returns the plaintext key (shown once, never stored), its 12-char prefix
 * (stored for display), and the hash (stored for lookup).
 *
 * When HMAC_KEY is configured the hash is HMAC-SHA256(plaintext, HMAC_KEY),
 * which prevents offline brute-force if the keyHash column leaks.
 * Without HMAC_KEY we fall back to plain SHA-256 for backward compatibility.
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

/**
 * Hash a plaintext API key for storage / lookup.
 * Uses HMAC-SHA256 when HMAC_KEY env var is set; falls back to plain SHA-256.
 */
export function hashApiKey(plaintext: string): string {
  if (env.HMAC_KEY) {
    return createHmac("sha256", env.HMAC_KEY).update(plaintext).digest("hex");
  }
  return hashApiKeyPlain(plaintext);
}

/** Plain SHA-256 hash — used for backward-compatible lookup of pre-migration keys. */
export function hashApiKeyPlain(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
