import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import type { Chain } from "@prisma/client";
import { getCoordinates } from "@medialane/sdk";
import { env } from "../config/env.js";

/**
 * EVM read adapter (Ethereum + Base) for the chainRead dispatch — on-demand,
 * read-only (spec 2026-06-13 §3.3; platform-federation §3.3). RPC precedence:
 * env override → the chain registry's rpcUrl.
 */

const ERC721_READS = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function owner() view returns (address)",
]);
const ERC1155_READS = parseAbi([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);

const clients = new Map<Chain, PublicClient>();

function evmClient(chain: Chain): PublicClient {
  const cached = clients.get(chain);
  if (cached) return cached;
  const override = chain === "ETHEREUM" ? env.ETHEREUM_RPC_URL : env.BASE_RPC_URL;
  let rpcUrl = override;
  if (!rpcUrl) {
    rpcUrl = (getCoordinates(chain as "ETHEREUM" | "BASE") as { rpcUrl: string }).rpcUrl;
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  clients.set(chain, client);
  return client;
}

export async function evmHoldsToken(
  chain: Chain,
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  const client = evmClient(chain);
  if (standard === "ERC721") {
    const balance = await client.readContract({
      address: contract as `0x${string}`,
      abi: ERC721_READS,
      functionName: "balanceOf",
      args: [owner as `0x${string}`],
    });
    return balance > 0n;
  }
  if (!knownTokenIds || knownTokenIds.length === 0) return false;
  const ids = knownTokenIds.slice(0, 100).map((id) => BigInt(id));
  const accounts = new Array<`0x${string}`>(ids.length).fill(owner as `0x${string}`);
  const balances = await client.readContract({
    address: contract as `0x${string}`,
    abi: ERC1155_READS,
    functionName: "balanceOfBatch",
    args: [accounts, ids],
  });
  return balances.some((b) => b > 0n);
}

export async function evmCollectionOwner(chain: Chain, contract: string): Promise<string> {
  const client = evmClient(chain);
  const owner = await client.readContract({
    address: contract as `0x${string}`,
    abi: ERC721_READS,
    functionName: "owner",
  });
  return owner;
}
