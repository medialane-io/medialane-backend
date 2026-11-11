import { randomBytes, createHmac } from "crypto";
import { env } from "../config/env.js";
import prisma from "../db/client.js";

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

type KeyOwner = { id: string; accountId: string };

/** Replaces the owner's key only if its current key is still `current` (null: none); otherwise returns null. The replaced key is kept as REVOKED. */
export async function replaceApiKey(
  owner: KeyOwner,
  current: string | null,
  generated: { prefix: string; keyHash: string },
  label?: string,
): Promise<{ id: string; prefix: string; label: string | null } | null> {
  return prisma.$transaction(async (tx) => {
    const replaced = await tx.apiKey.findFirst({ where: { apiCreditsId: owner.id, status: "ACTIVE" }, select: { id: true } });
    if ((replaced?.id ?? null) !== current) return null;
    if (replaced) await tx.apiKey.update({ where: { id: replaced.id }, data: { status: "REVOKED" } });
    const key = await tx.apiKey.create({
      data: { apiCreditsId: owner.id, prefix: generated.prefix, keyHash: generated.keyHash, label },
      select: { id: true, prefix: true, label: true },
    });
    return key;
  });
}

/** Revokes the owner's active key `id`. The key row is kept as REVOKED. */
export async function revokeApiKey(owner: KeyOwner, id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = await tx.apiKey.findFirst({ where: { id, apiCreditsId: owner.id, status: "ACTIVE" }, select: { id: true } });
    if (!key) return false;
    await tx.apiKey.update({ where: { id }, data: { status: "REVOKED" } });
    return true;
  });
}
