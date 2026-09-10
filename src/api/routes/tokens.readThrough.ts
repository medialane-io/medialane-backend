import { cairo, Contract } from "starknet";
import { IPCollectionABI, Medialane1155ABI } from "@medialane/sdk/starknet";
import type { Chain, TokenStandard } from "@prisma/client";
import { callRpc } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:tokens:readThrough");

const CHAIN_READ_TIMEOUT_MS = 5_000;

export interface OnChainToken {
  tokenUri: string | null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function decodeUri(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "bigint") return null;

  if (Array.isArray(raw)) {
    const joined = raw
      .map((part) => (typeof part === "bigint" ? feltToText(part) : String(part ?? "")))
      .join("");
    return joined.trim() || null;
  }
  return null;
}

function feltToText(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code > 0) out += String.fromCharCode(code);
  }
  return out;
}

export async function readTokenFromChain(
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  standard: TokenStandard | null,

  rpc: typeof callRpc = callRpc,
): Promise<OnChainToken | null> {
  if (chain !== "STARKNET") return null;

  return withTimeout(
    rpc(async (provider) => {
      const id = cairo.uint256(tokenId);

      if (standard === "ERC1155") {
        const contract = new Contract({
          abi: Medialane1155ABI as never,
          address: contractAddress,
          providerOrAccount: provider as never,
        });
        const uri = await contract.call("uri", [id], { blockIdentifier: "latest" });
        const decoded = decodeUri(uri);
        return decoded ? { tokenUri: decoded } : null;
      }

      const contract = new Contract({
        abi: IPCollectionABI as never,
        address: contractAddress,
        providerOrAccount: provider as never,
      });
      await contract.call("owner_of", [id], { blockIdentifier: "latest" });

      const uri = await contract
        .call("token_uri", [id], { blockIdentifier: "latest" })
        .catch(() => null);
      return { tokenUri: decodeUri(uri) };
    }),
    CHAIN_READ_TIMEOUT_MS,
  ).then((result) => {
    if (!result) {
      log.debug({ contractAddress, tokenId, standard }, "read-through: chain has no such token");
    }
    return result;
  });
}
