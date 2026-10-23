import { cairo, type BlockIdentifier } from "starknet";
import { callRpc, isContractError } from "../utils/starknet.js";
import { decodeText } from "./text.js";

export type CallContract = (contractAddress: string, entrypoint: string, calldata: string[]) => Promise<string[]>;

export function chainCallAt(blockIdentifier: BlockIdentifier, rpc: typeof callRpc = callRpc): CallContract {
  return (contractAddress, entrypoint, calldata) =>
    rpc((provider) => provider.callContract({ contractAddress, entrypoint, calldata }, blockIdentifier));
}

export async function callEither(
  call: CallContract,
  contractAddress: string,
  entrypoints: readonly string[],
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

export function u256Calldata(tokenId: string): string[] {
  const u = cairo.uint256(tokenId);
  return [u.low.toString(), u.high.toString()];
}

export async function readText(
  call: CallContract,
  contractAddress: string,
  entrypoints: readonly string[],
  calldata: string[] = [],
  opts?: { legacy?: boolean },
): Promise<string | null> {
  const raw = await callEither(call, contractAddress, entrypoints, calldata);
  return raw ? decodeText(raw, opts) : null;
}
