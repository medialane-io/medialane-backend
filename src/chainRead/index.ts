import type { Chain } from "@prisma/client";
import { adapterFor } from "../chains/adapter.js";

export { __unstable_starknetGetEscapeReadyAtWithProvider } from "../chains/starknet.js";

export async function holdsToken(
  chain: Chain,
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  return adapterFor(chain).holdsToken(contract, owner, standard, knownTokenIds);
}

export async function holdsTokenId(
  chain: Chain,
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  tokenId: string,
): Promise<boolean> {
  return adapterFor(chain).holdsTokenId(contract, owner, standard, tokenId);
}

export async function getCollectionOwner(chain: Chain, contract: string): Promise<string> {
  return adapterFor(chain).collectionOwner(contract);
}

export async function getEscapeReadyAt(chain: Chain, accountAddress: string): Promise<Date | null> {
  return adapterFor(chain).escapeReadyAt(accountAddress);
}
