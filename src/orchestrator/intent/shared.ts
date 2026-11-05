

import { cairo, num } from "starknet";
import { getService } from "@medialane/sdk";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { STARKNET_MARKETPLACE_721_CONTRACT, STARKNET_MARKETPLACE_1155_CONTRACT, STARKNET_COLLECTION_721_CONTRACT } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";

export const log = createLogger("intent");

export async function fetchCounter1155(address: string): Promise<string> {
  return fetchCounterFromContract(STARKNET_MARKETPLACE_1155_CONTRACT, address);
}

export function toHex(value: string | number | bigint): string {
  if (typeof value === "string") {
    if (value.startsWith("0x")) return value;
    try {
      return "0x" + BigInt(value).toString(16);
    } catch {
      return value;
    }
  }
  return "0x" + BigInt(value).toString(16);
}

export async function fetchCounter(address: string): Promise<string> {
  return fetchCounterFromContract(STARKNET_MARKETPLACE_721_CONTRACT, address);
}

async function fetchCounterFromContract(contractAddress: string, address: string): Promise<string> {
  const result = await callRpc((provider) =>
    provider.callContract({
      contractAddress,
      entrypoint: "get_counter",
      calldata: [normalizeAddress("STARKNET", address)],
    }),
  );
  if (!result?.[0]) throw new Error("Counter RPC returned no result");
  return BigInt(result[0]).toString();
}

/** royalty_info(token_id, sale_price = 10000): the royalty for a 10000-unit sale is the bps. RPC felts are hex. */
export function royaltyInfoCalldata(tokenId: string): string[] {
  const id = cairo.uint256(tokenId);
  return [toHex(BigInt(id.low)), toHex(BigInt(id.high)), toHex(10000), "0x0"];
}

export async function fetchRoyaltyMaxBps(nftContract: string, tokenId: string): Promise<string> {
  const calldata = royaltyInfoCalldata(tokenId);
  try {
    const result = await callRpc((provider) =>
      provider.callContract({
        contractAddress: normalizeAddress("STARKNET", nftContract),
        entrypoint: "royalty_info",
        calldata,
      }),
    );

    if (result?.[1] !== undefined) return BigInt(result[1]).toString();
  } catch {

  }
  return "0";
}

export function generateSalt(): string {

  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function resolveCollectionContract(override?: string, service?: string | null): string {
  if (override) return normalizeAddress("STARKNET", override);
  const registry = service ? getService(service)?.onchain?.STARKNET?.factoryAddress : undefined;
  return registry ? normalizeAddress("STARKNET", registry) : STARKNET_COLLECTION_721_CONTRACT;
}

export function encodeByteArray(str: string): string[] {
  const bytes = new TextEncoder().encode(str);
  const fullChunks: string[] = [];

  let i = 0;
  while (i + 31 <= bytes.length) {
    let val = 0n;
    for (const b of bytes.slice(i, i + 31)) {
      val = (val << 8n) | BigInt(b);
    }
    fullChunks.push(num.toHex(val));
    i += 31;
  }

  const remaining = bytes.slice(i);
  let pendingVal = 0n;
  for (const b of remaining) {
    pendingVal = (pendingVal << 8n) | BigInt(b);
  }

  return [
    fullChunks.length.toString(),
    ...fullChunks,
    num.toHex(pendingVal),
    remaining.length.toString(),
  ];
}
