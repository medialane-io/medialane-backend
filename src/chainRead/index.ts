import { Contract, cairo } from "starknet";
import type { Chain } from "@prisma/client";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import { evmCollectionOwner, evmHoldsToken } from "./evm.js";
import { solanaCollectionOwner, solanaHoldsToken } from "./solana.js";
import { stellarCollectionOwner, stellarHoldsToken } from "./stellar.js";

export async function holdsToken(
  chain: Chain,
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  switch (chain) {
    case "STARKNET":
      return starknetHoldsToken(contract, owner, standard, knownTokenIds);
    case "ETHEREUM":
    case "BASE":
      return evmHoldsToken(chain, contract, owner, standard, knownTokenIds);
    case "SOLANA":
      return solanaHoldsToken(chain, contract, owner, knownTokenIds);
    case "STELLAR":
      return stellarHoldsToken(chain, contract, owner, knownTokenIds);
    default:
      throw new Error(`Ownership checks not implemented for chain "${chain}"`);
  }
}

export async function getCollectionOwner(chain: Chain, contract: string): Promise<string> {
  switch (chain) {
    case "STARKNET":
      return starknetCollectionOwner(contract);
    case "ETHEREUM":
    case "BASE":
      return normalizeAddress(chain, await evmCollectionOwner(chain, contract));
    case "SOLANA":
      return normalizeAddress(chain, await solanaCollectionOwner(chain, contract));
    case "STELLAR":
      return normalizeAddress(chain, await stellarCollectionOwner(chain, contract));
    default:
      throw new Error(`Owner reads not implemented for chain "${chain}"`);
  }
}

export async function isAccountOwner(chain: Chain, accountAddress: string, ownerPubkey: string): Promise<boolean> {
  switch (chain) {
    case "STARKNET":
      return starknetIsAccountOwner(accountAddress, ownerPubkey);
    default:
      throw new Error(`Owner-membership reads not implemented for chain "${chain}"`);
  }
}

async function starknetHoldsToken(
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  if (standard === "ERC721") {

    const res = await callRpc((provider) => provider.callContract({
      contractAddress: contract,
      entrypoint: "balance_of",
      calldata: [owner],
    }));
    return res.length >= 2 && (BigInt(res[0] ?? "0x0") !== 0n || BigInt(res[1] ?? "0x0") !== 0n);
  }

  if (!knownTokenIds || knownTokenIds.length === 0) return false;
  const ids = knownTokenIds.slice(0, 100);
  const accounts = new Array<string>(ids.length).fill(owner);
  const idCalldata: string[] = [];
  for (const id of ids) {
    const u = cairo.uint256(id);
    idCalldata.push(u.low.toString(), u.high.toString());
  }
  const res = await callRpc((provider) => provider.callContract({
    contractAddress: contract,
    entrypoint: "balance_of_batch",
    calldata: [
      accounts.length.toString(), ...accounts,
      ids.length.toString(), ...idCalldata,
    ],
  }));
  const len = Number(BigInt(res[0] ?? "0x0"));
  for (let i = 0; i < len; i++) {
    const low = BigInt(res[1 + i * 2] ?? "0x0");
    const high = BigInt(res[2 + i * 2] ?? "0x0");
    if (low !== 0n || high !== 0n) return true;
  }
  return false;
}

async function starknetCollectionOwner(contract: string): Promise<string> {
  const ownerResult = await callRpc((provider) => {
    const c = new Contract({
      abi: [{ name: "owner", type: "function", inputs: [], outputs: [{ name: "owner", type: "core::starknet::contract_address::ContractAddress" }], state_mutability: "view" }],
      address: contract,
      providerOrAccount: provider,
    });
    return c.owner();
  });
  return normalizeAddress("STARKNET", String(ownerResult));
}

async function starknetIsAccountOwner(accountAddress: string, ownerPubkey: string): Promise<boolean> {
  return callRpc((provider) => __unstable_starknetIsAccountOwnerWithProvider(provider, accountAddress, ownerPubkey));
}

export async function __unstable_starknetIsAccountOwnerWithProvider(
  provider: { callContract: (call: { contractAddress: string; entrypoint: string; calldata: string[] }) => Promise<string[]> },
  accountAddress: string,
  ownerPubkey: string,
): Promise<boolean> {

  const res = await provider.callContract({
    contractAddress: accountAddress,
    entrypoint: "is_owner",
    calldata: ["0x0", ownerPubkey],
  });
  return BigInt(res[0]) === 1n;
}
