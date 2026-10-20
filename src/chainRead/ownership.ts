import { cairo, type BlockIdentifier } from "starknet";
import { ZERO_ADDRESS } from "../config/constants.js";
import type { ParsedEvent } from "../types/marketplace.js";
import { mapWithConcurrency } from "../utils/retry.js";
import { callRpc, isContractError, normalizeAddress } from "../utils/starknet.js";

export type OwnershipKey =
  | { standard: "ERC721"; contractAddress: string; tokenId: string }
  | { standard: "ERC1155"; contractAddress: string; tokenId: string; owner: string };

export type OwnershipFact =
  | { standard: "ERC721"; contractAddress: string; tokenId: string; owner: string | null }
  | { standard: "ERC1155"; contractAddress: string; tokenId: string; owner: string; amount: bigint };

export type CallContract = (contractAddress: string, entrypoint: string, calldata: string[]) => Promise<string[]>;

const READ_CONCURRENCY = 8;

/** Chain reads at a given block: "latest" for the indexer, "pre_confirmed" right after a transaction is confirmed. */
export function chainCallAt(blockIdentifier: BlockIdentifier, rpc: typeof callRpc = callRpc): CallContract {
  return (contractAddress, entrypoint, calldata) =>
    rpc((provider) => provider.callContract({ contractAddress, entrypoint, calldata }, blockIdentifier));
}

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

/** Calls the snake_case entrypoint, then the camelCase one; null when the contract refuses both. */
async function callEither(
  call: CallContract,
  contractAddress: string,
  entrypoints: [string, string],
  calldata: string[],
): Promise<string[] | null> {
  for (const entrypoint of entrypoints) {
    try {
      return await call(contractAddress, entrypoint, calldata);
    } catch (err) {
      if (!isContractError(err)) throw err;
    }
  }
  return null;
}

function u256Calldata(tokenId: string): string[] {
  const u = cairo.uint256(tokenId);
  return [u.low.toString(), u.high.toString()];
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
