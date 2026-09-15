import { cairo } from "starknet";
import { getService } from "@medialane/sdk";
import { callRpc, normalizeAddress } from "../../../utils/starknet.js";
import { encodeByteArray } from "../../../orchestrator/intent/shared.js";

export interface RegistryCall {
  contractAddress: string;
  entrypoint: "mint";
  calldata: string[];
}

export interface MintCallDeps {
  isCollectionOwner(registry: string, collectionId: string, owner: string): Promise<boolean>;
}

export function dataTokenizationRegistry(): string {
  const registry = getService("data-tokenization-erc721")?.onchain?.STARKNET?.factoryAddress;
  if (!registry) throw new Error("The Data Tokenization registry is not configured");
  return normalizeAddress("STARKNET", registry);
}

export function royaltyBps(royaltyPercent: number): number {
  return Math.round(royaltyPercent * 100);
}

export async function registryMintCalls(
  deps: MintCallDeps,
  input: { registry: string; collectionId: string; owner: string; tokenUris: string[]; royaltyPercent: number },
): Promise<RegistryCall[]> {
  const owner = normalizeAddress("STARKNET", input.owner);
  if (!(await deps.isCollectionOwner(input.registry, input.collectionId, owner))) {
    throw new Error("Only the collection's owner can tokenize into it");
  }
  const id = cairo.uint256(input.collectionId);
  const bps = String(royaltyBps(input.royaltyPercent));
  return input.tokenUris.map((tokenUri) => ({
    contractAddress: input.registry,
    entrypoint: "mint",
    calldata: [id.low.toString(), id.high.toString(), owner, ...encodeByteArray(tokenUri), bps],
  }));
}

export const productionMintCallDeps: MintCallDeps = {
  async isCollectionOwner(registry, collectionId, owner) {
    const id = cairo.uint256(collectionId);
    const result = await callRpc((provider) =>
      provider.callContract({
        contractAddress: registry,
        entrypoint: "is_collection_owner",
        calldata: [id.low.toString(), id.high.toString(), owner],
      }),
    );
    return Boolean(result[0]) && BigInt(result[0]!) !== 0n;
  },
};
