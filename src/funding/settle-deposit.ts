import { settleIntent } from "./core.js";
import { depositSatisfies } from "./methods/chain-transfer.js";
import type { DepositEvent } from "./deposits.js";
import type { FundingStore } from "./types.js";

export interface IntentSettlerDeps {
  store: FundingStore;
  mdlnMultiplier: (payer: string) => Promise<number>;
}

export interface SettledDeposit {
  paymentId: string;
  apiClientId: string;
}

/**
 * Settles the oldest open intent that a scanned treasury deposit satisfies. Anything that
 * matches no intent returns null and is left to the caller.
 */
export function intentSettler(deps: IntentSettlerDeps) {
  return async (deposit: DepositEvent, nonce: string): Promise<SettledDeposit | null> => {
    const open = await deps.store.openForPayer(deposit.payer, new Date());
    const intent = open.find((candidate) => depositSatisfies(deposit, candidate));
    if (!intent) return null;

    const result = await settleIntent(deps, intent, {
      valueUsdcAtomic: deposit.amountAtomic,
      asset: deposit.token,
      payer: deposit.payer,
      proofNonce: nonce,
      scheme: "starknet-transfer",
      network: "starknet",
      txHash: deposit.txHash,
    });
    return result.ok ? { paymentId: result.paymentId, apiClientId: intent.apiClientId } : null;
  };
}
