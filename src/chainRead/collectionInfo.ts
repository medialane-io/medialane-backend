import type { TokenStandard } from "@prisma/client";
import { normalizeAddress } from "../utils/starknet.js";
import { callEither, readText, type CallContract } from "./call.js";

const INTERFACE_ID_SRC5_ERC721 = "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16ea3175bd943";
const INTERFACE_ID_SRC5_ERC1155 = "0x6114a8f75559e1b39fcba08ce02961a1aa082d9256a158dd3e64964e4b1b52";
const INTERFACE_ID_ERC165_ERC721 = "0x80ac58cd";
const INTERFACE_ID_ERC165_ERC1155 = "0xd9b67a26";

const PROBES: Array<[TokenStandard, readonly string[]]> = [
  ["ERC1155", [INTERFACE_ID_SRC5_ERC1155, INTERFACE_ID_ERC165_ERC1155]],
  ["ERC721", [INTERFACE_ID_SRC5_ERC721, INTERFACE_ID_ERC165_ERC721]],
];

export async function readOwner(call: CallContract, contractAddress: string): Promise<string | null> {
  const raw = await callEither(call, contractAddress, ["owner"], []);
  if (!raw?.[0] || BigInt(raw[0]) === 0n) return null;
  return normalizeAddress("STARKNET", raw[0]);
}

export async function detectStandard(call: CallContract, contractAddress: string): Promise<TokenStandard | null> {
  for (const [standard, ids] of PROBES) {
    for (const id of ids) {
      const raw = await callEither(call, contractAddress, ["supports_interface", "supportsInterface"], [id]);
      if (raw?.[0] && BigInt(raw[0]) === 1n) return standard;
    }
  }
  return null;
}

const EMPTY = { name: "", symbol: "", baseUri: "" };

async function readFields(call: CallContract, contractAddress: string, legacy: boolean) {
  const [name, symbol, baseUri] = await Promise.all(
    ["name", "symbol", "base_uri"].map((entrypoint) => readText(call, contractAddress, [entrypoint], [], { legacy })),
  );
  return { name: name ?? "", symbol: symbol ?? "", baseUri: baseUri ?? "" };
}

export async function readCollectionInfo(
  call: CallContract,
  contractAddress: string,
  opts: { legacy: boolean },
): Promise<{ name: string; symbol: string; baseUri: string }> {
  const onChain = await readFields(call, contractAddress, false);
  if (onChain.name || onChain.symbol) return onChain;
  if (!opts.legacy) return EMPTY;
  const legacy = await readFields(call, contractAddress, true);
  return legacy.name || legacy.symbol ? legacy : EMPTY;
}
