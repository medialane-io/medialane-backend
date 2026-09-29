import { settleIntent } from "./core.js";
import { depositValueFor } from "./methods/chain-transfer.js";
import type { PriceReader } from "./methods/assets.js";
import type { DepositEvent } from "./deposits.js";
import type { FundingStore } from "./types.js";

export interface IntentSettlerDeps {
  store: FundingStore;
  mdlnMultiplier: (payer: string) => Promise<number>;
  readUsdPrices: PriceReader;
}

export interface SettledDeposit {
  paymentId: string;
  apiClientId: string;
}

/**
 * Settles the oldest open top-up of the paying wallet with a scanned treasury deposit, crediting what
 * the deposit is worth. A deposit that matches no top-up returns null and is left to the caller.
 */
export function intentSettler(deps: IntentSettlerDeps) {
  return async (deposit: DepositEvent, nonce: string): Promise<SettledDeposit | null> => {
    const open = await deps.store.openForPayer(deposit.payer, new Date());
    let unpriced = false;

    for (const candidate of open) {
      const match = await depositValueFor(deposit, candidate, deps.readUsdPrices);
      if (!match.ok) {
        if (match.reason === "unpriced") unpriced = true;
        continue;
      }
      const result = await settleIntent(deps, candidate, {
        valueUsdcAtomic: match.valueUsdcAtomic,
        asset: deposit.token,
        payer: deposit.payer,
        proofNonce: nonce,
        scheme: "starknet-transfer",
        network: "starknet",
        txHash: deposit.txHash,
      });
      return result.ok ? { paymentId: result.paymentId, apiClientId: candidate.apiClientId } : null;
    }

    // Retry the scan rather than let a deposit we could not price be credited by the legacy path.
    if (unpriced) throw new Error("No USD price to value a treasury deposit, retrying rather than crediting wrongly");
    return null;
  };
}
