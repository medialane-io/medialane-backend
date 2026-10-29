import { ec, typedData as starknetTypedData, type TypedData } from "starknet";
import { computeOwnerGuid, getGuardians, getOwners, signWithPrivateKey, type GuardianInfo } from "@medialane/sdk/starknet";
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

const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);

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
  if (deps.secret.length < 32 || ownerSignature.length !== 2) return ownerSignature;
  try {
    const address = normalizeAddress("STARKNET", wallet);
    const key = guardianKeyWith(deps.secret, address);
    const ours = computeOwnerGuid(key.publicKey);
    if (!(await read(() => deps.guardiansOf(address))).some((guardian) => sameFelt(guardian.guid, ours))) return ownerSignature;

    const messageHash = starknetTypedData.getMessageHash(typedData as TypedData, address);
    const guardianSignature = signWithPrivateKey(key.privateKey, messageHash);
    const owners = await read(() => deps.ownersOf(address));

    if (owners.length === 1 && owners[0]!.type === "Starknet") return [...ownerSignature, ...guardianSignature];

    const signature = new ec.starkCurve.Signature(BigInt(ownerSignature[0]!), BigInt(ownerSignature[1]!));
    const signer = owners.find((owner) => owner.type === "Starknet" && signedBy(signature, messageHash, owner.storedValue));
    if (!signer) return ownerSignature;
    return ["0x2", "0x0", signer.storedValue, ...ownerSignature, "0x0", key.publicKey, ...guardianSignature];
  } catch (err) {
    if (err instanceof GuardianUnavailableError) throw err;
    log.warn({ err, wallet }, "guardian co-signature skipped");
    return ownerSignature;
  }
}

export const productionCosign: Cosign = (wallet, typedData, ownerSignature) =>
  cosign(
    {
      secret: env.GUARDIAN_SECRET,
      guardiansOf: (address) => getGuardians(createProvider(), address),
      ownersOf: (address) => getOwners(createProvider(), address),
    },
    wallet,
    typedData,
    ownerSignature,
  );
