import { randomBytes, createHmac } from "crypto";
import { env } from "../config/env.js";

export function generateApiKey(): {
  plaintext: string;
  prefix: string;
  keyHash: string;
} {
  const raw = randomBytes(32).toString("hex");
  const plaintext = `ml_live_${raw}`;
  const prefix = plaintext.slice(0, 12);
  const keyHash = hashApiKey(plaintext);
  return { plaintext, prefix, keyHash };
}

export function hashApiKey(plaintext: string): string {
  return createHmac("sha256", env.HMAC_KEY).update(plaintext).digest("hex");
}
