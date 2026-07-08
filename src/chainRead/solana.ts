import type { Chain } from "@prisma/client";
import { getCoordinates } from "@medialane/sdk";
import { base58 } from "@scure/base";
import { env } from "../config/env.js";

/**
 * Solana read adapter — on-demand, read-only. Metaplex Core account layouts:
 * BaseAssetV1 = key(1) + owner(32) + …; BaseCollectionV1 = key(1) +
 * update_authority(32) + …. Raw JSON-RPC; no web3.js dependency server-side.
 */

function rpcUrl(): string {
  if (env.SOLANA_RPC_URL) return env.SOLANA_RPC_URL;
  return (getCoordinates("SOLANA") as { rpcUrl: string }).rpcUrl;
}

async function getAccountData(pubkey: string): Promise<Uint8Array | null> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey, { encoding: "base64" }],
    }),
  });
  const json = (await res.json()) as { result?: { value?: { data?: [string, string] } } };
  const b64 = json.result?.value?.data?.[0];
  if (!b64) return null;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Does `owner` hold any of the known Core assets? Asset pubkeys come from
 *  the indexer's token rows (capped); ownership is read on-chain. */
export async function solanaHoldsToken(
  _chain: Chain,
  _collection: string,
  owner: string,
  knownAssetIds?: string[],
): Promise<boolean> {
  if (!knownAssetIds || knownAssetIds.length === 0) return false;
  const ownerBytes = base58.decode(owner);
  for (const asset of knownAssetIds.slice(0, 50)) {
    const data = await getAccountData(asset);
    if (data && data.length >= 33) {
      const assetOwner = data.subarray(1, 33);
      if (assetOwner.every((b, i) => b === ownerBytes[i])) return true;
    }
  }
  return false;
}

/** The Core collection's update authority — the creator (claim verification). */
export async function solanaCollectionOwner(_chain: Chain, collection: string): Promise<string> {
  const data = await getAccountData(collection);
  if (!data || data.length < 33) throw new Error(`Solana collection account not found: ${collection}`);
  return base58.encode(data.subarray(1, 33));
}
