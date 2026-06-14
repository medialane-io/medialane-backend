import type { Chain } from "@prisma/client";
import { callRpc } from "../utils/starknet.js";

/**
 * Chain-dispatched wallet signature verification (spec 2026-06-13 §3.4).
 * Starknet (SNIP-12 / `is_valid_signature`) today; EVM (EIP-4361 / EIP-1271)
 * and Solana (ed25519) add a `case` here (litmus test) — no formal interface
 * until a second implementor exists.
 *
 * Returns a discriminated result so the caller maps reasons to HTTP codes:
 *   - `{ ok: true }`                    → issue a session token
 *   - `{ ok: false, reason: "invalid" }`      → 401
 *   - `{ ok: false, reason: "not_deployed" }` → 400 (counterfactual smart wallet)
 * Throws for unexpected RPC failures — the caller logs and returns 401.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "not_deployed" };

export async function verifyWalletSignature(args: {
  chain: Chain;
  address: string;
  typedData: unknown;
  signature: string[];
}): Promise<VerifyResult> {
  switch (args.chain) {
    case "STARKNET":
      return verifyStarknet(args.address, args.typedData, args.signature);
    default:
      throw new Error(`Signature verification not implemented for chain "${args.chain}"`);
  }
}

async function verifyStarknet(
  address: string,
  typedData: unknown,
  signature: string[],
): Promise<VerifyResult> {
  try {
    const normalizedSignature = signature.map((value) => BigInt(value).toString());
    const isValid = await callRpc((provider) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider.verifyMessageInStarknet(typedData as any, normalizedSignature, address),
    );
    return isValid ? { ok: true } : { ok: false, reason: "invalid" };
  } catch (err) {
    // Smart wallets on Starknet are counterfactual until their first tx —
    // is_valid_signature has no contract to call, surfaced as "Contract not
    // found" (RPC code 20). Distinguish so the UI can prompt "deploy first".
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Contract not found")) {
      return { ok: false, reason: "not_deployed" };
    }
    throw err; // unexpected RPC error — caller logs + 401
  }
}
