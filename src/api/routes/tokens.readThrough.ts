import { cairo, Contract } from "starknet";
import { IPCollectionABI, Medialane1155ABI } from "@medialane/sdk/starknet";
import type { Chain, TokenStandard } from "@prisma/client";
import { callRpc } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:tokens:readThrough");

// The chain is the authority; the Token table is a projection of it that trails
// by a few blocks. A row being absent therefore means "not indexed yet", which
// is indistinguishable to a client from "does not exist" — and that is what
// turned a successful mint into "Token not found" moments after the confetti.
//
// So on a miss we ask the authority directly. If the chain has the token we
// write the same minimal PENDING row the indexer would have written, and let
// the existing metadata path fill it in. A 404 then means what it says.
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
  // Cairo byte-array / felt-span shapes come back as arrays of felts.
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

/**
 * Asks the chain whether a token exists. Returns null when it does not, or when
 * the chain could not be reached — a read-through must never invent existence.
 */
export async function readTokenFromChain(
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  standard: TokenStandard | null,
  // Injected rather than module-mocked in tests: callRpc is shared by most of
  // the codebase, and mock.module leaks across files within a single run.
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

      // ERC721 (and unknown, which the 721 interface covers for our collections):
      // owner_of reverts for a token that was never minted, so a successful call
      // is the existence proof. token_uri is best-effort on top of it.
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
