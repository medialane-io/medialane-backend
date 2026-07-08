import { Contract, cairo } from "starknet";
import type { Chain } from "@prisma/client";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import { evmCollectionOwner, evmHoldsToken } from "./evm.js";
import { solanaCollectionOwner, solanaHoldsToken } from "./solana.js";

/**
 * On-demand, read-only chain reads behind ONE dispatch point (spec 2026-06-13
 * §3.3). Starknet-only today; adding a chain adds a `case` here (litmus test) —
 * no formal interface until a second implementor exists. The Starknet bulk
 * poller is unchanged; foreign chains use only this on-demand path, triggered
 * by claim / gated-content / admin flows, never by polling.
 *
 * Reads throw on RPC failure — callers surface 503 and MUST NOT fall back to
 * the DB cache for an authorization decision (07-identity §V).
 */

/**
 * Does `owner` hold ≥1 token of `contract`? The on-chain authority for
 * token-gated content (07-identity §V). ERC-721 → `balance_of`; ERC-1155 →
 * `balance_of_batch` over the indexer's known token ids (capped).
 */
export async function holdsToken(
  chain: Chain,
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  switch (chain) {
    case "STARKNET":
      return starknetHoldsToken(contract, owner, standard, knownTokenIds);
    case "ETHEREUM":
    case "BASE":
      return evmHoldsToken(chain, contract, owner, standard, knownTokenIds);
    case "SOLANA":
      return solanaHoldsToken(chain, contract, owner, knownTokenIds);
    default:
      throw new Error(`Ownership checks not implemented for chain "${chain}"`);
  }
}

/**
 * Collection-level `owner()` — used by on-chain claim verification. Returns the
 * normalized owner (may be the zero address); throws on RPC failure so callers
 * can distinguish "checked, mismatched" from "could not check".
 */
export async function getCollectionOwner(chain: Chain, contract: string): Promise<string> {
  switch (chain) {
    case "STARKNET":
      return starknetCollectionOwner(contract);
    case "ETHEREUM":
    case "BASE":
      return normalizeAddress(chain, await evmCollectionOwner(chain, contract));
    case "SOLANA":
      return normalizeAddress(chain, await solanaCollectionOwner(chain, contract));
    default:
      throw new Error(`Owner reads not implemented for chain "${chain}"`);
  }
}

// ─── Starknet implementations ────────────────────────────────────────────────

async function starknetHoldsToken(
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  if (standard === "ERC721") {
    // OZ Cairo ERC-721: balance_of(account) → u256 [low, high].
    const res = await callRpc((provider) => provider.callContract({
      contractAddress: contract,
      entrypoint: "balance_of",
      calldata: [owner],
    }));
    return res.length >= 2 && (BigInt(res[0] ?? "0x0") !== 0n || BigInt(res[1] ?? "0x0") !== 0n);
  }

  // ERC-1155: no "owns any in collection" call — batch over known ids (capped).
  if (!knownTokenIds || knownTokenIds.length === 0) return false;
  const ids = knownTokenIds.slice(0, 100);
  const accounts = new Array<string>(ids.length).fill(owner);
  const idCalldata: string[] = [];
  for (const id of ids) {
    const u = cairo.uint256(id);
    idCalldata.push(u.low.toString(), u.high.toString());
  }
  const res = await callRpc((provider) => provider.callContract({
    contractAddress: contract,
    entrypoint: "balance_of_batch",
    calldata: [
      accounts.length.toString(), ...accounts,
      ids.length.toString(), ...idCalldata,
    ],
  }));
  const len = Number(BigInt(res[0] ?? "0x0"));
  for (let i = 0; i < len; i++) {
    const low = BigInt(res[1 + i * 2] ?? "0x0");
    const high = BigInt(res[2 + i * 2] ?? "0x0");
    if (low !== 0n || high !== 0n) return true;
  }
  return false;
}

async function starknetCollectionOwner(contract: string): Promise<string> {
  const ownerResult = await callRpc((provider) => {
    const c = new Contract(
      [{ name: "owner", type: "function", inputs: [], outputs: [{ name: "owner", type: "core::starknet::contract_address::ContractAddress" }], state_mutability: "view" }],
      contract,
      provider,
    );
    return c.owner();
  });
  return normalizeAddress("STARKNET", String(ownerResult));
}
