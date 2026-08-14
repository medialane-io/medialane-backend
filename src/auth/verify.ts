import type { Chain } from "@prisma/client";
import { callRpc } from "../utils/starknet.js";
import { createPublicClient, http } from "viem";
import { getCoordinates } from "@medialane/sdk";
import { env } from "../config/env.js";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "not_deployed" };

export async function verifyWalletSignature(args: {
  chain: Chain;
  address: string;
  typedData: unknown;
  signature: string[];

  message?: string;
}): Promise<VerifyResult> {
  switch (args.chain) {
    case "STARKNET":
      return verifyStarknet(args.address, args.typedData, args.signature);
    case "ETHEREUM":
    case "BASE":
      return verifyEvm(args.chain, args.address, args.message ?? "", args.signature);
    case "SOLANA":
      return verifySolana(args.address, args.message ?? "", args.signature);
    case "STELLAR":
      return verifyStellar(args.address, args.message ?? "", args.signature);
    default:
      throw new Error(`Signature verification not implemented for chain "${args.chain}"`);
  }
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
      if (!msg.includes("Contract not found")) throw err;
      if (i === retries) return { ok: false, reason: "not_deployed" };
      await sleep(delayMs);
    }
  }
  return { ok: false, reason: "not_deployed" };
}

async function verifyStarknet(
  address: string,
  typedData: unknown,
  signature: string[],
): Promise<VerifyResult> {
  const normalizedSignature = signature.map((value) => BigInt(value).toString());
  return verifyStarknetWithRetry(() =>
    callRpc((provider) =>

      provider.verifyMessageInStarknet(typedData as any, normalizedSignature, address),
    ),
  );
}

async function verifyEvm(
  chain: Chain,
  address: string,
  message: string,
  signature: string[],
): Promise<VerifyResult> {
  if (!message || signature.length === 0) return { ok: false, reason: "invalid" };
  const override = chain === "ETHEREUM" ? env.ETHEREUM_RPC_URL : env.BASE_RPC_URL;
  let rpcUrl = override;
  if (!rpcUrl) {
    try {
      rpcUrl = (getCoordinates(chain as "ETHEREUM" | "BASE") as { rpcUrl: string }).rpcUrl;
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  try {
    const valid = await client.verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature[0] as `0x${string}`,
    });
    return valid ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

async function verifySolana(
  address: string,
  message: string,
  signature: string[],
): Promise<VerifyResult> {
  if (!message || signature.length === 0) return { ok: false, reason: "invalid" };
  try {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { base58 } = await import("@scure/base");
    const valid = ed25519.verify(
      base58.decode(signature[0]!),
      new TextEncoder().encode(message),
      base58.decode(address),
    );
    return valid ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

async function verifyStellar(
  address: string,
  message: string,
  signature: string[],
): Promise<VerifyResult> {
  if (!message || signature.length === 0) return { ok: false, reason: "invalid" };
  try {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { StrKey } = await import("@stellar/stellar-sdk");
    const pub = StrKey.decodeEd25519PublicKey(address);
    const raw = signature[0]!;
    const sig = raw.startsWith("0x")
      ? Uint8Array.from(Buffer.from(raw.slice(2), "hex"))
      : Uint8Array.from(Buffer.from(raw, "base64"));
    const valid = ed25519.verify(sig, new TextEncoder().encode(message), new Uint8Array(pub));
    return valid ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
