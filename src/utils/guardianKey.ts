import { deriveOwnerKeyPair } from "@medialane/sdk/starknet";
import { env } from "../config/env.js";
import { normalizeAddress } from "./starknet.js";

export interface GuardianKey {
  privateKey: string;
  publicKey: string;
}

const VERSION = "v1";

export function guardianKeyWith(secret: string, walletAddress: string, version: string = VERSION): GuardianKey {
  if (secret.length < 32) throw new Error("GUARDIAN_SECRET is not configured");
  return deriveOwnerKeyPair(
    new TextEncoder().encode(secret),
    `guardian:${version}:${normalizeAddress("STARKNET", walletAddress)}`,
  );
}

export function guardianKey(walletAddress: string): GuardianKey {
  return guardianKeyWith(env.GUARDIAN_SECRET, walletAddress);
}
