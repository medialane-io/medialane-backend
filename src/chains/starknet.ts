import { Contract, cairo, type TypedData } from "starknet";
import { getEscape } from "@medialane/sdk/starknet";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import type { ChainAdapter, VerifyResult } from "./adapter.js";

export async function __unstable_starknetGetEscapeReadyAtWithProvider(
  provider: Parameters<typeof getEscape>[0],
  accountAddress: string,
): Promise<Date | null> {
  const escape = await getEscape(provider, accountAddress);
  return escape.readyAt > 0 ? new Date(escape.readyAt * 1000) : null;
}

async function holdsToken(
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  knownTokenIds?: string[],
): Promise<boolean> {
  if (standard === "ERC721") {

    const res = await callRpc((provider) => provider.callContract({
      contractAddress: contract,
      entrypoint: "balance_of",
      calldata: [owner],
    }));
    return res.length >= 2 && (BigInt(res[0] ?? "0x0") !== 0n || BigInt(res[1] ?? "0x0") !== 0n);
  }

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

async function holdsTokenId(
  contract: string,
  owner: string,
  standard: "ERC721" | "ERC1155",
  tokenId: string,
): Promise<boolean> {
  if (standard === "ERC1155") return holdsToken(contract, owner, standard, [tokenId]);
  const id = cairo.uint256(tokenId);
  const res = await callRpc((provider) => provider.callContract({
    contractAddress: contract,
    entrypoint: "owner_of",
    calldata: [id.low.toString(), id.high.toString()],
  }));
  return res.length > 0 && normalizeAddress("STARKNET", res[0]!) === normalizeAddress("STARKNET", owner);
}

async function collectionOwner(contract: string): Promise<string> {
  const ownerResult = await callRpc((provider) => {
    const c = new Contract({
      abi: [{ name: "owner", type: "function", inputs: [], outputs: [{ name: "owner", type: "core::starknet::contract_address::ContractAddress" }], state_mutability: "view" }],
      address: contract,
      providerOrAccount: provider,
    });
    return c.owner();
  });
  return normalizeAddress("STARKNET", String(ownerResult));
}

export async function verifyStarknetWithRetry(
  attempt: () => Promise<boolean>,
  opts: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<VerifyResult> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i <= retries; i++) {
    try {
      const isValid = await attempt();
      return isValid ? { ok: true } : { ok: false, reason: "invalid" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notYetIndexed = msg.includes("Contract not found") || msg.includes("resp[0]");
      if (!notYetIndexed) throw err;
      if (i === retries) return { ok: false, reason: "not_deployed" };
      await sleep(delayMs);
    }
  }
  return { ok: false, reason: "not_deployed" };
}

async function verifySignature(address: string, typedData: unknown, signature: string[]): Promise<VerifyResult> {
  const normalizedSignature = signature.map((value) => BigInt(value).toString());
  return verifyStarknetWithRetry(() =>
    callRpc((provider) =>
      provider.verifyMessageInStarknet(typedData as TypedData, normalizedSignature, address),
    ),
  );
}

export const starknetAdapter: ChainAdapter = {
  holdsToken,
  holdsTokenId,
  collectionOwner,
  escapeReadyAt: (account) => callRpc((provider) => __unstable_starknetGetEscapeReadyAtWithProvider(provider, account)),
  verifySignature,
};
