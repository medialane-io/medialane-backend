import type { Chain } from "@prisma/client";
import { callRpc } from "../utils/starknet.js";

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
  if (args.chain !== "STARKNET") {
    throw new Error(`Signature verification not implemented for chain "${args.chain}"`);
  }
  return verifyStarknet(args.address, args.typedData, args.signature);
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
