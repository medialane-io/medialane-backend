import type { Chain } from "@prisma/client";
import { adapterFor, type VerifyResult } from "../chains/adapter.js";

export { verifyStarknetWithRetry } from "../chains/starknet.js";
export type { VerifyResult } from "../chains/adapter.js";

export async function verifyWalletSignature(args: {
  chain: Chain;
  address: string;
  typedData: unknown;
  signature: string[];

  message?: string;
}): Promise<VerifyResult> {
  return adapterFor(args.chain).verifySignature(args.address, args.typedData, args.signature);
}
