import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const generateAppSecret = (): string => randomBytes(32).toString("base64url");

export const hashAppSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export function appSecretMatches(secret: string | undefined, hashes: string[]): boolean {
  if (!secret) return false;
  const given = Buffer.from(hashAppSecret(secret), "hex");
  return hashes.some((h) => {
    const stored = Buffer.from(h, "hex");
    return stored.length === given.length && timingSafeEqual(stored, given);
  });
}
