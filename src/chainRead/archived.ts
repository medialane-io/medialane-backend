import { callEither, chainCallAt, u256Calldata, type CallContract } from "./call.js";

const chainCall = chainCallAt("latest");

export interface ArchivedKey {
  contractAddress: string;
  tokenId: string;
}

export async function readArchived(key: ArchivedKey, call: CallContract = chainCall): Promise<boolean> {
  const res = await callEither(call, key.contractAddress, ["is_archived"], u256Calldata(key.tokenId));
  return res?.[0] != null && BigInt(res[0]) !== 0n;
}
