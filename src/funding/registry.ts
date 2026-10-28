import { callRpc } from "../utils/starknet.js";
import { readUsdPrices } from "../utils/usdPrices.js";
import { verifyWalletSignature } from "../auth/verify.js";
import { productionCosign } from "../utils/guardianCosign.js";
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
      verifySignature: async (args) =>
        verifyWalletSignature({ ...args, signature: await productionCosign(args.address, args.typedData, args.signature) }),
      readUsdPrices,
    }),
  ];
}
