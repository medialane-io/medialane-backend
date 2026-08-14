

import { cairo, hash, num } from "starknet";
import { normalizeAddress } from "../../utils/starknet.js";
import { STARKNET_MARKETPLACE_721_CONTRACT, STARKNET_MARKETPLACE_1155_CONTRACT, STARKNET_COLLECTION_721_CONTRACT } from "../../config/constants.js";
import { postRpc } from "../../utils/rpcFetch.js";
import { createLogger } from "../../utils/logger.js";

export const log = createLogger("intent");

const GET_COUNTER_SELECTOR = hash.getSelectorFromName("get_counter");
const ROYALTY_INFO_SELECTOR = hash.getSelectorFromName("royalty_info");

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
  const { result } = await postRpc<string[]>(
    {
      jsonrpc: "2.0",
      method: "starknet_call",
      params: {
        request: {
          contract_address: contractAddress,
          entry_point_selector: GET_COUNTER_SELECTOR,
          calldata: [normalizeAddress("STARKNET", address)],
        },
        block_id: "latest",
      },
      id: 1,
    },
    { contractAddress },
  );
  if (!result?.[0]) throw new Error("Counter RPC returned no result");
  return BigInt(result[0]).toString();
}

export async function fetchRoyaltyMaxBps(nftContract: string, tokenId: string): Promise<string> {
  const id = cairo.uint256(tokenId);
  const calldata = [id.low.toString(), id.high.toString(), "10000", "0"];
  try {
    const { result } = await postRpc<string[]>(
      {
        jsonrpc: "2.0",
        method: "starknet_call",
        params: {
          request: {
            contract_address: normalizeAddress("STARKNET", nftContract),
            entry_point_selector: ROYALTY_INFO_SELECTOR,
            calldata,
          },
          block_id: "latest",
        },
        id: 1,
      },
      { nftContract },
    );

    if (result?.[1] !== undefined) return BigInt(result[1]).toString();
  } catch {

  }
  return "0";
}

interface OrderLegInput {
  itemType: string;
  token: string;
  identifierOrCriteria: string | number | bigint;
  amount: string | number | bigint;
  recipient?: string;
}

export function buildOrderParams(input: {
  offerer: string;
  marketplace: string;
  offer: OrderLegInput;
  consideration: OrderLegInput;
  royaltyMaxBps: string | number | bigint;
  startTime: number;
  endTime: number;
  salt: string;
  counter: string;
}) {
  return {
    offerer: toHex(input.offerer),
    marketplace: toHex(input.marketplace),
    offer: {
      item_type: input.offer.itemType,
      token: toHex(input.offer.token),
      identifier_or_criteria: toHex(input.offer.identifierOrCriteria),
      amount: toHex(input.offer.amount),
    },
    consideration: {
      item_type: input.consideration.itemType,
      token: toHex(input.consideration.token),
      identifier_or_criteria: toHex(input.consideration.identifierOrCriteria),
      amount: toHex(input.consideration.amount),
      recipient: toHex(input.consideration.recipient ?? ""),
    },
    royalty_max_bps: toHex(input.royaltyMaxBps),
    start_time: toHex(input.startTime),
    end_time: toHex(input.endTime),
    salt: toHex(input.salt),
    counter: toHex(input.counter),
  };
}

export function generateSalt(): string {

  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function resolveCollectionContract(override?: string): string {
  return override ? normalizeAddress("STARKNET", override) : STARKNET_COLLECTION_721_CONTRACT;
}

export function parseAmount(humanAmount: string, decimals: number): bigint {
  const parts = humanAmount.replace(/,/g, "").split(".");
  const integer = BigInt(parts[0] || "0");
  const fraction = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return integer * BigInt(10 ** decimals) + BigInt(fraction);
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
