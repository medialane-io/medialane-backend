import { randomBytes, createHmac } from "crypto";
import { env } from "../config/env.js";
import prisma from "../db/client.js";
import { recordAccountEvent } from "./accountEvents.js";

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

export async function replaceApiKey(
  owner: KeyOwner,
  generated: { prefix: string; keyHash: string },
  label?: string,
): Promise<{ id: string; prefix: string; label: string | null }> {
  return prisma.$transaction(async (tx) => {
    const replaced = await tx.apiKey.findFirst({ where: { apiCreditsId: owner.id }, select: { prefix: true } });
    await tx.apiKey.deleteMany({ where: { apiCreditsId: owner.id } });
    const key = await tx.apiKey.create({
      data: { apiCreditsId: owner.id, prefix: generated.prefix, keyHash: generated.keyHash, label },
      select: { id: true, prefix: true, label: true },
    });
    await recordAccountEvent(tx, owner.accountId, "API_KEY_CREATED", {
      prefix: key.prefix,
      replacedPrefix: replaced?.prefix ?? null,
    });
    return key;
  });
}

export async function deleteApiKey(owner: KeyOwner, id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = await tx.apiKey.findFirst({ where: { id, apiCreditsId: owner.id }, select: { prefix: true } });
    if (!key) return false;
    await tx.apiKey.delete({ where: { id } });
    await recordAccountEvent(tx, owner.accountId, "API_KEY_DELETED", { prefix: key.prefix });
    return true;
  });
}
