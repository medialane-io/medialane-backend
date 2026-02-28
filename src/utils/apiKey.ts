import { randomBytes, createHash } from "crypto";

/**
 * Generate a new API key.
 * Returns the plaintext key (shown once, never stored), its 12-char prefix
 * (stored for display), and the SHA-256 hash (stored for lookup).
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

/** SHA-256 hex of the raw plaintext key. Used on every inbound request. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
