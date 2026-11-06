import { RpcError, ec, typedData as starknetTypedData, type TypedData } from "starknet";
import { computeOwnerGuid, getGuardians, getOwners, signWithPrivateKey, type GuardianInfo, sameFelt } from "@medialane/sdk/starknet";
import { env } from "../config/env.js";
import { createLogger } from "./logger.js";
import { guardianKeyWith } from "./guardianKey.js";
import { createProvider, normalizeAddress } from "./starknet.js";

const log = createLogger("guardian-cosign");

export interface CosignDeps {
  secret: string;
  guardiansOf(address: string): Promise<GuardianInfo[]>;
  ownersOf(address: string): Promise<GuardianInfo[]>;
}

export class GuardianUnavailableError extends Error {
  constructor() {
    super("The wallet's guardian could not be read");
    this.name = "GuardianUnavailableError";
  }
}

export type Cosign = (wallet: string, typedData: unknown, ownerSignature: string[]) => Promise<string[]>;


function signedBy(signature: InstanceType<typeof ec.starkCurve.Signature>, messageHash: string, starkKey: string): boolean {
  const x = BigInt(starkKey).toString(16).padStart(64, "0");
  return ["02", "03"].some((prefix) => ec.starkCurve.verify(signature, messageHash, prefix + x));
}

async function read<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.warn({ err }, "wallet guardian could not be read");
    throw new GuardianUnavailableError();
  }
}

export async function cosign(
  deps: CosignDeps,
  wallet: string,
  typedData: unknown,
  ownerSignature: string[],
): Promise<string[]> {
  if (ownerSignature.length !== 2) return ownerSignature;
  try {
    const address = normalizeAddress("STARKNET", wallet);
    const messageHash = starknetTypedData.getMessageHash(typedData as TypedData, address);
    const key = deps.secret.length >= 32 ? guardianKeyWith(deps.secret, address) : null;
    const guarded =
      key !== null &&
      (await read(() => deps.guardiansOf(address))).some((guardian) => sameFelt(guardian.guid, computeOwnerGuid(key.publicKey)));
    const guardianSignature = guarded ? signWithPrivateKey(key.privateKey, messageHash) : [];
    const owners = await read(() => deps.ownersOf(address));

    // The short form names no signer, so the wallet accepts it only from a single Starknet owner.
    if (owners.length === 1 && owners[0]!.type === "Starknet") return [...ownerSignature, ...guardianSignature];

    const signature = new ec.starkCurve.Signature(BigInt(ownerSignature[0]!), BigInt(ownerSignature[1]!));
    const signer = owners.find((owner) => owner.type === "Starknet" && signedBy(signature, messageHash, owner.storedValue));
    if (!signer) return ownerSignature;
    const signed = ["0x0", signer.storedValue, ...ownerSignature];
    return guarded ? ["0x2", ...signed, "0x0", key.publicKey, ...guardianSignature] : ["0x1", ...signed];
  } catch (err) {
    if (err instanceof GuardianUnavailableError) throw err;
    log.warn({ err, wallet }, "guardian co-signature skipped");
    return ownerSignature;
  }
}

export async function emptyWithoutEntrypoint<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof RpcError && err.isType("ENTRYPOINT_NOT_FOUND")) return [];
    throw err;
  }
}

export const productionCosign: Cosign = (wallet, typedData, ownerSignature) =>
  cosign(
    {
      secret: env.GUARDIAN_SECRET,
      guardiansOf: (address) => emptyWithoutEntrypoint(() => getGuardians(createProvider(), address)),
      ownersOf: (address) => emptyWithoutEntrypoint(() => getOwners(createProvider(), address)),
    },
    wallet,
    typedData,
    ownerSignature,
  );
