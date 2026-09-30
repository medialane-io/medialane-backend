import { deriveOwnerKeyPair, computeAccountAddress } from "@medialane/sdk/starknet";
import { env } from "../config/env.js";

export interface ProvisioningKeyInput {
  apiClientId: string;
  recipientScheme: string;
  recipientValue: string;
  salt: string;
}

export interface ProvisioningKey {
  privateKey: string;
  publicKey: string;
  walletAddress: string;
}

export function provisioningKeyWith(secret: string, input: ProvisioningKeyInput): ProvisioningKey {
  if (secret.length < 32) throw new Error("PROVISIONING_SECRET is not configured");
  const { privateKey, publicKey } = deriveOwnerKeyPair(
    new TextEncoder().encode(secret),
    `${input.apiClientId}:${input.recipientScheme}:${input.recipientValue}:${input.salt}`,
  );
  return { privateKey, publicKey, walletAddress: computeAccountAddress(publicKey, 0) };
}

export function provisioningKey(input: ProvisioningKeyInput): ProvisioningKey {
  return provisioningKeyWith(env.PROVISIONING_SECRET, input);
}
