import { callRpc } from "../utils/starknet.js";
import { verifyWalletSignature } from "../auth/verify.js";
import { createChainTransferMethod } from "./methods/chain-transfer.js";
import type { StarknetReceipt } from "../payments/schemes/starknet.js";
import type { FundingMethod } from "./types.js";

export function productionFundingMethods(): FundingMethod[] {
  return [
    createChainTransferMethod({
      fetchReceipt: (hash) =>
        callRpc((provider) =>
          (provider as { getTransactionReceipt: (h: string) => Promise<StarknetReceipt> }).getTransactionReceipt(hash),
        ),
      verifySignature: verifyWalletSignature,
    }),
  ];
}
