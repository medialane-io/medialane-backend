import { ZERO_ADDRESS } from "../config/constants.js";
import type { ParsedEvent } from "../types/marketplace.js";
import { mapWithConcurrency } from "../utils/retry.js";
import { normalizeAddress } from "../utils/starknet.js";
import { callEither, chainCallAt, u256Calldata, type CallContract } from "./call.js";

export type OwnershipKey =
  | { standard: "ERC721"; contractAddress: string; tokenId: string }
  | { standard: "ERC1155"; contractAddress: string; tokenId: string; owner: string };

export type OwnershipFact =
  | { standard: "ERC721"; contractAddress: string; tokenId: string; owner: string | null }
  | { standard: "ERC1155"; contractAddress: string; tokenId: string; owner: string; amount: bigint };

const READ_CONCURRENCY = 8;

const chainCall = chainCallAt("latest");

/** The tokens and holders whose current ownership a set of transfer events changed. */
export function ownershipKeys(events: ParsedEvent[]): OwnershipKey[] {
  const keys = new Map<string, OwnershipKey>();
  const add721 = (contractAddress: string, tokenId: string) =>
    keys.set(`ERC721:${contractAddress}:${tokenId}`, { standard: "ERC721", contractAddress, tokenId });
  const add1155 = (contractAddress: string, tokenId: string, holder: string) => {
    if (holder === ZERO_ADDRESS) return;
    const owner = normalizeAddress("STARKNET", holder);
    keys.set(`ERC1155:${contractAddress}:${tokenId}:${owner}`, { standard: "ERC1155", contractAddress, tokenId, owner });
  };

  for (const event of events) {
    if (event.type === "Transfer") {
      add721(event.contractAddress, event.tokenId);
    } else if (event.type === "TransferSingle") {
      add1155(event.contractAddress, event.tokenId, event.from);
      add1155(event.contractAddress, event.tokenId, event.to);
    } else if (event.type === "TransferBatch") {
      for (const { tokenId } of event.transfers) {
        add1155(event.contractAddress, tokenId, event.from);
        add1155(event.contractAddress, tokenId, event.to);
      }
    }
  }
  return [...keys.values()];
}

/** Current on-chain ownership for each key. Transport failures throw; contract refusals mean no ownership. */
export async function readOwnership(keys: OwnershipKey[], call: CallContract = chainCall): Promise<OwnershipFact[]> {
  return mapWithConcurrency(keys, READ_CONCURRENCY, async (key): Promise<OwnershipFact> => {
    if (key.standard === "ERC721") {
      const res = await callEither(call, key.contractAddress, ["owner_of", "ownerOf"], u256Calldata(key.tokenId));
      const owner = res?.[0] != null ? normalizeAddress("STARKNET", res[0]) : null;
      return { ...key, owner: owner === ZERO_ADDRESS ? null : owner };
    }
    const res = await callEither(call, key.contractAddress, ["balance_of", "balanceOf"], [key.owner, ...u256Calldata(key.tokenId)]);
    const amount = res ? BigInt(res[0] ?? "0x0") + (BigInt(res[1] ?? "0x0") << 128n) : 0n;
    return { ...key, amount };
  });
}
