import { deriveOwnerKeyPair, computeAccountAddress } from "@medialane/sdk/starknet";
import { env } from "../config/env.js";

export interface ProvisioningKey {
  privateKey: string;
  publicKey: string;
  walletAddress: string;
}

export function provisioningKeyWith(secret: string, accountId: string): ProvisioningKey {
  if (secret.length < 32) throw new Error("PROVISIONING_SECRET is not configured");
  const { privateKey, publicKey } = deriveOwnerKeyPair(new TextEncoder().encode(secret), accountId);
  return { privateKey, publicKey, walletAddress: computeAccountAddress(publicKey, 0) };
}

export function provisioningKey(accountId: string): ProvisioningKey {
  return provisioningKeyWith(env.PROVISIONING_SECRET, accountId);
}
