import type { Call } from "starknet";
import { getListableTokens } from "@medialane/sdk";
import { normalizeAddress } from "../../utils/starknet.js";
import type { IntentCall } from "./fee.js";

/** An SDK-built call in the intent's stored shape: normalized target, string calldata. */
export function toIntentCall(call: Call): IntentCall {
  return {
    contractAddress: normalizeAddress("STARKNET", call.contractAddress),
    entrypoint: call.entrypoint,
    calldata: ((call.calldata ?? []) as unknown[]).map(String),
  };
}

export function isListableToken(address: string): boolean {
  const a = normalizeAddress("STARKNET", address);
  return getListableTokens().some((t) => normalizeAddress("STARKNET", t.address) === a);
}
