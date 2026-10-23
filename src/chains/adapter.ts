import type { Chain } from "@prisma/client";
import { starknetAdapter } from "./starknet.js";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "not_deployed" };

export interface ChainAdapter {
  holdsToken(
    contract: string,
    owner: string,
    standard: "ERC721" | "ERC1155",
    knownTokenIds?: string[],
  ): Promise<boolean>;
  holdsTokenId(contract: string, owner: string, standard: "ERC721" | "ERC1155", tokenId: string): Promise<boolean>;
  collectionOwner(contract: string): Promise<string>;
  escapeReadyAt(account: string): Promise<Date | null>;
  verifySignature(address: string, typedData: unknown, signature: string[]): Promise<VerifyResult>;
}

export class UnsupportedChain extends Error {
  constructor(readonly chain: Chain) {
    super(`Chain "${chain}" is not supported here`);
  }
}

const adapters: Partial<Record<Chain, ChainAdapter>> = { STARKNET: starknetAdapter };

export function adapterFor(chain: Chain, registry: Partial<Record<Chain, ChainAdapter>> = adapters): ChainAdapter {
  const adapter = registry[chain];
  if (!adapter) throw new UnsupportedChain(chain);
  return adapter;
}
